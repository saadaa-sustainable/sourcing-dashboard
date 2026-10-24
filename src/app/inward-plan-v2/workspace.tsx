'use client';

import { Search } from 'lucide-react';

import type { ReactNode } from 'react';
import { Fragment, useActionState, useEffect, useRef, useState, useTransition } from 'react';
import { savePlan, reviewPlan, validatePlan } from './actions';
import { deadlineLabel, periodBounds, planTitle, validDate } from '@/lib/inward-plan-v2/validation';
import { STATUS_LABEL } from '@/lib/inward-plan-v2/types';
import type { HeaderDraft, LineDraft, Plan, PlanLine, Result, SourceLine, ProductSource } from '@/lib/inward-plan-v2/types';
import styles from './v2.module.css';

const INITIAL: Result = { ok: false, message: '' };

function Feedback({ result }: { result: Result }) {
  if (!result.message) return null;
  return <div className={result.ok ? 'wf-notice wf-notice-ok' : 'wf-notice wf-notice-error'} role="status">
    {result.message}
    {!!result.errors?.length && <ul>{result.errors.map(error => <li key={error}>{error}</li>)}</ul>}
  </div>;
}
export function Workspace({ plan, lines, sources, role, email, today }: {
  plan: Plan | null; lines: PlanLine[]; sources: SourceLine[];
  role: 'viewer' | 'team' | 'admin'; email: string; today: string;
}) {
  const [dirty, setDirty] = useState(false);
  const [approvalNotes, setApprovalNotes] = useState('');
  const [editorSaving, setEditorSaving] = useState(false);
  const [validation, setValidation] = useState<Result>(INITIAL);
  const [validating, startValidation] = useTransition();
  const [review, reviewAction, reviewing] = useActionState(reviewPlan, INITIAL);
  const editable = role !== 'viewer' && (!plan || plan.status !== 'approved') &&
    (!plan || role === 'admin' || plan.created_by === email);
  const canDecide = plan && role === 'admin' && (plan.status === 'pending_l2' || plan.status === 'approved');
  const canSubmit = plan && editable && ['draft', 'rework', 'rejected'].includes(plan.status);
  useEffect(() => {
    if (!dirty) return;
    const warn = (event: BeforeUnloadEvent) => event.preventDefault();
    window.addEventListener('beforeunload', warn);
    return () => window.removeEventListener('beforeunload', warn);
  }, [dirty]);
  const reviewSection = plan && <section className={styles.source}>
      <h3>{role === 'admin' ? 'Review and decision' : 'Validation and submission'}</h3>
      <p className={styles.muted}>{canDecide && plan.status === 'pending_l2' ? 'Approve uses saved values. Approve with Edits saves the fields above and approves them together.' : 'Validation and decisions use the saved plan and current PO quantities. Save your edits first.'}</p>
      <button className="wf-btn wf-btn-ghost" type="button" disabled={dirty || validating || reviewing || editorSaving}
        onClick={() => startValidation(async () => setValidation(await validatePlan(plan.id)))}>
        {validating ? 'Validating…' : 'Validate saved plan'}
      </button>
      <Feedback result={validation} />
      {dirty && <p role="status">{canDecide && plan.status === 'pending_l2' ? 'You have unsaved edits. Use Approve with Edits to save and approve them together, or Save changes to keep the plan pending.' : 'You have unsaved edits. Save them before validating or deciding.'}</p>}
      {(canSubmit || canDecide) && <form action={reviewAction} className={styles.form}>
        <input type="hidden" name="plan_id" value={plan.id} />
        <input type="hidden" name="version" value={plan.updated_at} />
        {canDecide && <label>Review remarks <span className={styles.muted}>{plan.status === 'approved' ? '(required for reopening)' : '(optional)'}</span>
          <textarea name="notes" maxLength={4000} rows={3} className="wf-input" value={approvalNotes} onChange={event => setApprovalNotes(event.target.value)} disabled={reviewing || editorSaving} />
        </label>}
        <div className={styles.buttons}>
          {canSubmit && <button className="wf-btn wf-btn-primary" name="decision" value="submit" disabled={reviewing || editorSaving || dirty}>
            {reviewing ? 'Submitting…' : plan.status === 'draft' ? 'Submit for approval' : 'Resubmit for approval'}
          </button>}
          {canDecide && plan.status === 'pending_l2' && <>
            <button className={`wf-btn wf-btn-primary ${styles.approvalButton}`} name="decision" value="approve" disabled={reviewing || editorSaving || dirty}>Approve</button>
            <button className={`wf-btn wf-btn-ghost ${styles.approvalButton}`} type="submit" form="inward-plan-editor" name="intent" value="approve_with_edits" disabled={reviewing || editorSaving}>Approve with Edits</button>
          </>}
          {canDecide && plan.status === 'approved' &&
            <button className="wf-btn wf-btn-ghost" name="decision" value="reopen" disabled={reviewing || editorSaving}>Reopen for amendment</button>}
        </div>
      </form>}
      <Feedback result={review} />
    </section>;
  const planSummary = plan && <div aria-label="Plan summary">
      <div className={styles.heading}><h2>{plan.title}</h2><span className={styles.status}>{STATUS_LABEL[plan.status]}</span></div>
      <p>{plan.period_kind === 'weekly' ? 'Weekly' : 'Monthly'} · {plan.period_start} – {plan.period_end} · Revision {plan.revision}</p>
      <p>Submit by <strong>{deadlineLabel(plan.submission_deadline)}</strong></p>
      <p className={styles.muted}>Owner: {plan.created_by}{plan.submitted_at ? ' · Submitted: ' + new Date(plan.submitted_at).toLocaleString('en-IN', { timeZone: 'Asia/Kolkata' }) + ' IST' : ''}</p>
      {plan.decision_notes && <p><strong>Review remarks:</strong> {plan.decision_notes}</p>}
      {plan.approved_by && <p>Approved by {plan.approved_by} · {plan.approved_at && new Date(plan.approved_at).toLocaleString('en-IN', { timeZone: 'Asia/Kolkata' })} IST</p>}
    </div>;
  return <>
    {editable ? <Editor key={plan?.updated_at ?? 'new'} plan={plan} lines={lines} initialSources={sources} today={today} summary={planSummary} approvalNotes={approvalNotes} onSavingChange={setEditorSaving} onDirty={() => setDirty(true)}>{reviewSection}</Editor> :
      <section className={styles.card}>
        {planSummary && <div className={styles.summaryAboveEditor}>{planSummary}</div>}
        <h2>Planned receipts</h2>
        {plan?.remarks && <p>{plan.remarks}</p>}
        <div className={styles.scroll}><table className={styles.table}>
          <caption className={styles.srOnly}>PO and product receipt schedule</caption>
          <thead><tr><th>PO / Product Code</th><th>Vendor</th><th>Receipt date</th><th>Quantity</th><th>Cost / piece</th><th>Remarks</th></tr></thead>
          <tbody>{lines.map(line => <tr key={line.id}>
            <td>{line.po_ref_num || line.po_number}<br /><strong>{line.product_code}</strong></td>
            <td>{line.vendor_name}</td><td>{line.expected_date}</td><td>{Number(line.inward_qty).toLocaleString('en-IN')}</td>
            <td>{line.cost_per_piece == null ? '—' : Number(line.cost_per_piece).toLocaleString('en-IN')}</td><td>{line.remarks}</td>
          </tr>)}</tbody>
        </table></div>
        {!lines.length && <p>No lines saved yet.</p>}
        {reviewSection}
      </section>}
  </>;
}

function Editor({ plan, lines, initialSources, today, onDirty, children, summary, approvalNotes, onSavingChange }: {
  plan: Plan | null; lines: PlanLine[]; initialSources: SourceLine[]; today: string; onDirty: () => void; children?: ReactNode; summary?: ReactNode; approvalNotes: string; onSavingChange: (saving: boolean) => void;
}) {
  const [header, setHeader] = useState<HeaderDraft>({
    id: plan?.id, title: plan?.title ?? '', remarks: plan?.remarks ?? '',
    period_kind: plan?.period_kind ?? 'monthly', period_start: plan?.period_start ?? today.slice(0, 8) + '01',
  });
  const [drafts, setDrafts] = useState<LineDraft[]>(lines.map(line => ({
    id: line.id, planning_level: line.planning_level ?? 'sku', po_number: line.po_number, po_detail_id: line.po_detail_id ?? '', expected_date: line.expected_date,
    po_label: line.po_ref_num || line.po_number, vendor_name: line.vendor_name ?? '', product_code: line.product_code, sku: line.sku ?? '',
    inward_qty: String(line.inward_qty), cost_per_piece: line.cost_per_piece == null ? '' : String(line.cost_per_piece),
    remarks: line.remarks ?? '', label: (line.po_ref_num || line.po_number) + ' · ' + line.sku + ' · ' + (line.vendor_name ?? ''),
  })));
  const [choices, setChoices] = useState(initialSources);
  const productChoices = productOptions(choices);
  const [addedMessage, setAddedMessage] = useState('');
  const focusAdded = useRef(false);
  const addedQuantity = useRef<HTMLInputElement>(null);
  useEffect(() => {
    if (!focusAdded.current) return;
    focusAdded.current = false;
    addedQuantity.current?.focus();
    addedQuantity.current?.scrollIntoView({ block: 'center', behavior: 'smooth' });
  }, [drafts.length]);
  const [query, setQuery] = useState('');
  const [field, setField] = useState<'product' | 'variant'>('product');
  const [searchError, setSearchError] = useState('');
  const [searching, startSearch] = useTransition();
  const [saved, saveAction, saving] = useActionState(savePlan, INITIAL);
  useEffect(() => { onSavingChange(saving); }, [saving, onSavingChange]);
  let bounds: ReturnType<typeof periodBounds> | null = null;
  try { bounds = periodBounds(header.period_kind, header.period_start); } catch { /* Show server validation on save. */ }
  const generatedTitle = validDate(header.period_start) ? planTitle(header.period_kind, header.period_start) : '';
  function changeHeader(change: Partial<HeaderDraft>) { setHeader(current => ({ ...current, ...change })); onDirty(); }
  function changeLine(index: number, change: Partial<LineDraft>) {
    setDrafts(current => current.map((line, i) => i === index ? { ...line, ...change } : line)); onDirty();
  }
  function add(source: ProductSource) {
    focusAdded.current = true;
    setAddedMessage(source.product_code + ' added to the schedule. Enter its total receipt quantity above.');
    const expected = source.expected_delivery_date && bounds &&
      source.expected_delivery_date >= bounds.start && source.expected_delivery_date <= bounds.end
      ? source.expected_delivery_date : header.period_start;
    setDrafts(current => [...current, {
      planning_level: 'product', po_number: source.po_number, po_detail_id: '', expected_date: expected, inward_qty: '',
      po_label: source.po_ref_num || source.po_number, vendor_name: source.vendor_name ?? '', product_code: source.product_code,
      cost_per_piece: source.item_price == null ? '' : String(source.item_price), remarks: '',
      label: (source.po_ref_num || source.po_number) + ' / ' + source.product_code,
    }]); onDirty();
  }
  return <section className={styles.card}>
    {summary && <div className={styles.summaryAboveEditor}>{summary}</div>}
    <h2>{plan ? 'Edit plan' : 'Create a plan'}</h2>
    <p className={styles.muted}>Weekly plans run Monday–Sunday. Monthly plans cover the calendar month. Weekly submission closes Monday EOD IST; monthly submission closes on the 2nd EOD IST.</p>
    <form id="inward-plan-editor" action={saveAction} className={styles.form} onKeyDown={event => {
      // Enter in a text/quantity field must not submit and replace the draft.
      if (event.key === 'Enter' && event.target instanceof HTMLInputElement &&
        ['text', 'number'].includes(event.target.type)) event.preventDefault();
    }}>
      <input type="hidden" name="plan_id" value={plan?.id ?? ''} />
      <input type="hidden" name="version" value={plan?.updated_at ?? ''} />
      <input type="hidden" name="lines" value={JSON.stringify(drafts)} />
      <input type="hidden" name="approval_notes" value={approvalNotes} />
      <fieldset disabled={saving} className={styles.fieldset}>
        <div className={styles.grid}>
          <label>Plan title<input className="wf-input" name="title" readOnly value={generatedTitle} aria-describedby="plan-title-hint" /><span id="plan-title-hint" className={styles.titleHint}>Plan title is auto-generated from the planning period and start date</span></label>
          <label>Planning period<select className="wf-input" name="period_kind" value={header.period_kind} onChange={e => {
            const kind = e.target.value as HeaderDraft['period_kind'];
            const date = new Date((header.period_start || today) + 'T00:00:00Z');
            if (kind === 'monthly') date.setUTCDate(1);
            else date.setUTCDate(date.getUTCDate() - (date.getUTCDay() + 6) % 7);
            changeHeader({ period_kind: kind, period_start: date.toISOString().slice(0, 10) });
          }}><option value="monthly">Monthly</option><option value="weekly">Weekly</option></select></label>
          <label>{header.period_kind === 'weekly' ? 'Week starting Monday' : 'Month starting on the 1st'}
            <input className="wf-input" name="period_start" type="date" required value={header.period_start}
              onChange={e => changeHeader({ period_start: e.target.value })} /></label>
        </div>
        {bounds && <p>Period ends {bounds.end} · Submit by {deadlineLabel(bounds.deadline)}</p>}
        <label>Plan remarks<textarea className="wf-input" name="remarks" rows={2} maxLength={4000} value={header.remarks} onChange={e => changeHeader({ remarks: e.target.value })} /></label>
        <h3>Inward plan schedule ({drafts.length} lines)</h3>
        {!drafts.length && <p>Add products using the PO search below. You can save an empty draft.</p>}
        <div className={styles.scroll}><table className={styles.table}>
          <caption className={styles.srOnly}>Editable receipt schedule</caption>
          <thead><tr><th>PO No</th><th>Vendor Name</th><th>Product Code</th><th>Expected Inward Date</th><th>Quantity</th><th>Cost/piece</th><th>Remarks</th><th>Remove</th></tr></thead>
          <tbody>{drafts.map((line, index) => <tr key={line.id ?? 'new-' + index}>
            <td><span>{line.po_label}</span><details><summary className={styles.muted}>Change PO/product</summary>
              <select className="wf-input" aria-label={'PO/product for line ' + (index + 1)}
                value={JSON.stringify([line.po_number, line.product_code])} onChange={e => {
                  const source = productChoices.find(option => productKey(option) === e.target.value);
                  if (source) changeLine(index, { planning_level: 'product', po_number: source.po_number, po_detail_id: '',
                    po_label: source.po_ref_num || source.po_number, vendor_name: source.vendor_name ?? '', product_code: source.product_code,
                    label: (source.po_ref_num || source.po_number) + ' / ' + source.product_code,
                    cost_per_piece: source.item_price == null ? '' : String(source.item_price) });
                }}>
                {!productChoices.some(option => productKey(option) === JSON.stringify([line.po_number, line.product_code])) &&
                  <option value={JSON.stringify([line.po_number, line.product_code])}>{line.po_label} / {line.product_code}</option>}
                {productChoices.map(source => <option key={productKey(source)} value={productKey(source)}>{source.po_ref_num || source.po_number} / {source.product_code}</option>)}
              </select></details>{line.planning_level !== 'product' && <small className={styles.muted}>Existing legacy line</small>}</td>
            <td>{line.vendor_name || 'N/A'}</td>
            <td>{line.product_code}</td>
            <td><input className="wf-input" type="date" required aria-label={'Receipt date for line ' + (index + 1)}
              min={bounds?.start} max={bounds?.end} value={line.expected_date} onChange={e => changeLine(index, { expected_date: e.target.value })} /></td>
            <td><input ref={index === drafts.length - 1 ? addedQuantity : undefined} className="wf-input" type="number" required min="0.001" step="0.001" aria-label={'Quantity for line ' + (index + 1)}
              value={line.inward_qty} onChange={e => changeLine(index, { inward_qty: e.target.value })} /></td>
            <td><input className="wf-input" type="number" min="0" step="0.0001" aria-label={'Cost for line ' + (index + 1)}
              value={line.cost_per_piece} onChange={e => changeLine(index, { cost_per_piece: e.target.value })} /></td>
            <td><input className="wf-input" maxLength={4000} aria-label={'Remarks for line ' + (index + 1)}
              value={line.remarks} onChange={e => changeLine(index, { remarks: e.target.value })} /></td>
            <td><button className="btn" type="button" aria-label={'Remove line ' + (index + 1)}
              onClick={() => { setDrafts(current => current.filter((_, i) => i !== index)); onDirty(); }}>Remove</button></td>
          </tr>)}</tbody>
        </table></div>
        <div className={styles.buttons}><button className="wf-btn wf-btn-primary" type="submit">{saving ? 'Saving…' : plan ? 'Save changes' : 'Save draft'}</button></div>
      </fieldset>
    </form>
    <Feedback result={saved} />
    {children}
    <div className={styles.source}>
      <h3>Add from open, approved POs</h3>
      <form className={styles.sourceSearch} onSubmit={event => {
        event.preventDefault();
        startSearch(async () => {
          setSearchError('');
          try {
            const params = new URLSearchParams({ query, field });
            const response = await fetch('/inward-plan-v2/sources?' + params, { cache: 'no-store', credentials: 'same-origin' });
            const result: { rows?: SourceLine[]; error?: string } = await response.json();
            if (!response.ok || !Array.isArray(result.rows)) throw new Error(result.error || 'Product/variant search failed.');
            setChoices(result.rows);
          } catch (error) {
            setSearchError(error instanceof Error ? error.message : 'Product/variant search failed. Try again.');
          }
        });
      }}>
        <label>Search by<select className="wf-input" value={field} onChange={e => setField(e.target.value as 'product' | 'variant')}><option value="product">Product Code</option><option value="variant">Variant Code</option></select></label>
        <label>Search term<input className="wf-input" maxLength={80} value={query} onChange={e => setQuery(e.target.value)} placeholder="Enter a product code or variant code" /></label>
        <button className="wf-btn wf-btn-primary" type="submit" disabled={searching} aria-busy={searching}><Search size={15} aria-hidden="true" />{searching ? 'Searching…' : 'Search'}</button>
      </form>
      {searchError && <p role="alert">{searchError}</p>}
      {addedMessage && <p role="status">{addedMessage}</p>}
      <p className={styles.muted}>Showing all matching approved PO lines with pending quantity. Leave the search term blank to show all products. Source data is read-only.</p>
      <InventoryPicker choices={choices} add={add} disabled={saving} remaining={500 - drafts.length} />
      {!choices.length && <p>No matching open PO lines. Try another product code or variant code.</p>}
    </div>
  </section>;
}

const INVENTORY_SIZES = ['XS', 'S', 'M', 'L', 'XL', '2XL', '3XL', '4XL', '5XL'];
const inventoryNumber = new Intl.NumberFormat('en-IN', { maximumFractionDigits: 2 });
const normalizedSize = (size: string | null) => (size ?? '').trim().toUpperCase().replace(/^XXL$/, '2XL').replace(/^XXXL$/, '3XL');
function InventoryPicker({ choices, add, disabled, remaining }: { choices: SourceLine[]; add: (source: ProductSource) => void; disabled: boolean; remaining: number }) {
  const [selected, setSelected] = useState<string | null>(null);
  const popup = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    if (selected) popup.current?.showModal();
    else popup.current?.close();
  }, [selected]);
  const products = new Map<string, Map<string, SourceLine[]>>();
  for (const source of choices) {
    const variants = products.get(source.product_code) ?? new Map<string, SourceLine[]>();
    const variant = source.product_variant || source.product_code;
    variants.set(variant, [...(variants.get(variant) ?? []), source]);
    products.set(source.product_code, variants);
  }
  const keyOf = (product: string, variant: string) => JSON.stringify([product, variant]);
  const selectedLines = choices.filter(source => keyOf(source.product_code, source.product_variant || source.product_code) === selected);
  const poRows = new Map<string, SourceLine[]>();
  for (const source of selectedLines) {
    const key = JSON.stringify([source.po_number, source.expected_delivery_date, source.product_code, source.product_variant]);
    poRows.set(key, [...(poRows.get(key) ?? []), source]);
  }
  const sourceSize = (source: SourceLine) => normalizedSize(source.size || (source.product_variant && source.sku?.startsWith(source.product_variant) ? source.sku.slice(source.product_variant.length).replace(/^[_\s-]+/, '') : null));
  const extraSizes = [...new Set(selectedLines.map(sourceSize).filter(size => !INVENTORY_SIZES.includes(size)))];
  const poSizes = [...INVENTORY_SIZES, ...extraSizes];
  return <>
    <h3>Inventory View</h3>
    <p className={styles.muted}>Use current inventory and demand to decide what should be inwarded. Main Warehouse; DOQ = 45-day daily order quantity; DOH = Current Stock / DOQ. N/A means inventory is unavailable or DOQ is zero.</p>
    <div className={`${styles.scroll} ${styles.inventoryScroll}`} role="region" aria-label="Scrollable inventory view" tabIndex={0}><table className={`${styles.table} ${styles.inventory}`}>
      <caption className={styles.srOnly}>Inventory by product, variant and size</caption>
      <thead><tr><th>Product Code</th><th>Variant Code</th><th>Size</th>{INVENTORY_SIZES.map(size => <th key={size}>{size}</th>)}<th>View PO Detail</th></tr></thead>
      <tbody>{[...products].map(([product, variants]) => [...variants].map(([variant, sources], index) => {
        const inventory = sources[0].inventory ?? [];
        const sizes = INVENTORY_SIZES.map(size => inventory.filter(row => normalizedSize(row.size || (row.sku.startsWith(variant) ? row.sku.slice(variant.length).replace(/^[_\s-]+/, '') : null)) === size));
        return <Fragment key={keyOf(product, variant)}>{['Current Stock', 'DOQ (Daily Order Quantity)', 'DOH (Inventory Days on Hand)'].map((label, metric) => <tr key={label}>
          {index === 0 && metric === 0 && <th scope="rowgroup" rowSpan={variants.size * 3}>{product}</th>}
          {metric === 0 && <th scope="rowgroup" rowSpan={3}>{variant}</th>}
          <th scope="row">{label}</th>
          {sizes.map((rows, sizeIndex) => {
            const stock = rows.length && rows.every(row => row.current_stock != null) ? rows.reduce((sum, row) => sum + Number(row.current_stock), 0) : null;
            const doq = rows.length && rows.every(row => row.doq_45 != null) ? rows.reduce((sum, row) => sum + Number(row.doq_45), 0) : null;
            const value = metric === 0 ? stock : metric === 1 ? doq : stock != null && doq != null && doq > 0 ? stock / doq : null;
            return <td key={INVENTORY_SIZES[sizeIndex]}>{value == null ? 'N/A' : inventoryNumber.format(value)}</td>;
          })}
          {metric === 0 && <td rowSpan={3}><button className="wf-btn wf-btn-ghost wf-btn-sm" type="button" aria-haspopup="dialog" aria-expanded={selected === keyOf(product, variant)} onClick={() => setSelected(selected === keyOf(product, variant) ? null : keyOf(product, variant))}>View PO Detail<span className={styles.srOnly}> for {variant}</span></button></td>}
        </tr>)}</Fragment>;
      }))}</tbody>
    </table></div>
    <dialog ref={popup} className={styles.poDialog} aria-labelledby="po-detail-heading" onCancel={() => setSelected(null)} onClose={() => setSelected(null)}>
      <div className={styles.heading}><h3 id="po-detail-heading">PO details: {selectedLines[0]?.product_variant || selectedLines[0]?.sku}</h3>
        <button className="btn" type="button" onClick={() => setSelected(null)} aria-label="Close PO details">Close</button></div>
      <p className={styles.muted}>Pending quantities by size are reference only. Add to Inward Plan adds one PO/product row for a total receipt quantity across all variants and sizes.</p>
      <div className={styles.scroll}><table className={`${styles.table} ${styles.poTable}`}>
        <caption className={styles.srOnly}>PO View: pending quantities by size</caption>
        <thead><tr><th>PO No.</th><th>Expected Delivery Date</th><th>Product Code</th><th>Variant Code</th>{poSizes.map(size => <th key={size}>{size || 'Unknown size'}</th>)}<th>Action</th></tr></thead>
        <tbody>{[...poRows].map(([key, sources]) => {
          const source = sources[0];
          return <tr key={key}>
            <td><div className={styles.poCell}>{source.po_ref_num || source.po_number}</div></td><td><div className={styles.poCell}>{source.expected_delivery_date || 'N/A'}</div></td>
            <td><div className={styles.poCell}>{source.product_code}</div></td><td><div className={styles.poCell}>{source.product_variant || 'N/A'}</div></td>
            {poSizes.map(size => <td key={size}><div className={styles.poCell}>{inventoryNumber.format(sources.filter(line => sourceSize(line) === size).reduce((sum, line) => sum + Number(line.pending_qty), 0))}</div></td>)}
            <td><div className={styles.poCell}><button className="wf-btn wf-btn-ghost wf-btn-sm" type="button" disabled={disabled || remaining < 1}
              title={remaining < 1 ? 'The schedule has reached its 500-line limit.' : undefined}
              onClick={() => { popup.current?.close(); setSelected(null); add(productOptions(choices).find(product => product.po_number === source.po_number && product.product_code === source.product_code)!); }}
              aria-label={'Add to Inward Plan from ' + source.po_number}>Add to Inward Plan</button></div></td>
          </tr>;
        })}</tbody>
      </table></div>
    </dialog>
  </>;
}

function productKey(source: Pick<ProductSource, 'po_number' | 'product_code'>) {
  return JSON.stringify([source.po_number, source.product_code]);
}
function productOptions(sources: SourceLine[]): ProductSource[] {
  const products = new Map<string, ProductSource>();
  for (const source of sources) {
    const key = productKey(source);
    const old = products.get(key);
    if (!old) products.set(key, { ...source });
    else {
      old.pending_qty = Number(old.pending_qty) + Number(source.pending_qty);
      if (Number(old.item_price) !== Number(source.item_price) || (old.item_price == null) !== (source.item_price == null)) old.item_price = null;
      if (source.expected_delivery_date && (!old.expected_delivery_date || source.expected_delivery_date < old.expected_delivery_date)) old.expected_delivery_date = source.expected_delivery_date;
    }
  }
  return [...products.values()];
}
