'use client';

import { Search } from 'lucide-react';
import { Combobox } from '@/components/forms/combobox';

import type { ReactNode } from 'react';
import { Fragment, useActionState, useEffect, useMemo, useRef, useState, useTransition } from 'react';
import { savePlan, reviewPlan, validatePlan } from './actions';
import { deadlineLabel, periodBounds, planTitle, validDate } from '@/lib/inward-plan-v2/validation';
import { STATUS_LABEL } from '@/lib/inward-plan-v2/types';
import { variantInventoryTotals } from '@/lib/inward-plan-v2/inventory';
import { productKey, productOptions } from '@/lib/inward-plan-v2/products';
import { ScheduleCsvUpload } from './schedule-csv-upload';
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
  const productChoices = useMemo(() => productOptions(choices), [choices]);
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
  const [importing, setImporting] = useState(false);
  useEffect(() => { onSavingChange(saving || importing); }, [saving, importing, onSavingChange]);
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
      <fieldset disabled={saving || importing} className={styles.fieldset}>
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
        <ScheduleCsvUpload header={header} drafts={drafts} onBusy={setImporting} onImport={lines => {
          focusAdded.current = true;
          setDrafts(current => [...current, ...lines]); onDirty();
        }} />
        <div className={styles.entryDivider}><span>OR</span></div>
        <div className={styles.manualEntry}>
          <div><h4>Add Inward Plan Entries manually</h4><p>Choose products from open, approved purchase orders.</p></div>
          <a className="wf-btn wf-btn-ghost" href="#inward-v2-open-pos">Add from open, approved POs</a>
        </div>
        <div className={styles.scheduleTableHeading}>
          <h4>Schedule entries</h4>
          <span>{drafts.length} {drafts.length === 1 ? 'line' : 'lines'}</span>
        </div>
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
      <h3 id="inward-v2-open-pos" className={styles.anchorHeading} tabIndex={-1}>Add from open, approved POs</h3>
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
      <InventoryPicker choices={choices} add={add} disabled={saving || importing} remaining={500 - drafts.length} />
      <PendingPoPicker products={productChoices} add={add} disabled={saving || importing} remaining={500 - drafts.length} />
      {!choices.length && <p>No matching open PO lines. Try another product code or variant code.</p>}
    </div>
  </section>;
}

const INVENTORY_SIZES = ['XS', 'S', 'M', 'L', 'XL', '2XL', '3XL', '4XL', '5XL'];
const inventoryNumber = new Intl.NumberFormat('en-IN', { maximumFractionDigits: 2 });
const normalizedSize = (size: string | null) => (size ?? '').trim().toUpperCase().replace(/^XXL$/, '2XL').replace(/^XXXL$/, '3XL');
function PendingPoPicker({ products, add, disabled, remaining }: {
  products: ProductSource[]; add: (source: ProductSource) => void; disabled: boolean; remaining: number;
}) {
  const [query, setQuery] = useState('');
  const [vendorQuery, setVendorQuery] = useState('');
  const [productQuery, setProductQuery] = useState('');
  const vendorOptions = useMemo(() => [{ value: '', label: 'All vendors' }, ...[...new Set(products.map(source => source.vendor_name).filter((value): value is string => !!value))]
    .sort((a, b) => a.localeCompare(b)).map(value => ({ value, label: value }))], [products]);
  const productOptions = useMemo(() => [{ value: '', label: 'All products' }, ...[...new Set(products.map(source => source.product_code))]
    .sort((a, b) => a.localeCompare(b)).map(value => ({ value, label: value }))], [products]);
  const [page, setPage] = useState(1);
  const pageSize = 25;
  const filtered = useMemo(() => {
    const term = query.trim().toLowerCase();
    return products.filter(source => (!term || [source.po_number, source.po_ref_num, source.vendor_name, source.product_code]
      .some(value => value?.toLowerCase().includes(term))) &&
      (!vendorQuery || source.vendor_name === vendorQuery) &&
      (!productQuery || source.product_code === productQuery))
      .sort((a, b) => a.po_number.localeCompare(b.po_number, undefined, { numeric: true }) || a.product_code.localeCompare(b.product_code));
  }, [products, query, vendorQuery, productQuery]);
  const pages = Math.max(1, Math.ceil(filtered.length / pageSize));
  const currentPage = Math.min(page, pages);
  const visible = filtered.slice((currentPage - 1) * pageSize, currentPage * pageSize);
  const groups = new Map<string, ProductSource[]>();
  for (const source of visible) groups.set(source.po_number, [...(groups.get(source.po_number) ?? []), source]);
  const number = (value: number) => Number(value).toLocaleString('en-IN', { maximumFractionDigits: 3 });
  return <section className={styles.pendingPoSection} aria-labelledby="pending-pos-heading">
    <h3 id="pending-pos-heading">Pending POs View</h3>
    <p className={styles.muted}>Pick a product code directly from its pending PO. Quantities combine matching variants and sizes within each PO/product; the product/variant search above applies to this view too.</p>
    <div className={styles.pendingPoToolbar}>
      <label>Search pending POs<input className="wf-input" type="search" value={query}
        onChange={event => { setQuery(event.target.value); setPage(1); }} placeholder="PO number, vendor or product code" /></label>
      <label>Vendor<Combobox value={vendorQuery} options={vendorOptions} allowFreeText={false} ariaLabel="Filter pending POs by vendor"
        onChange={value => { setVendorQuery(value); setPage(1); }} placeholder="All vendors" /></label>
      <label>Product Code<Combobox value={productQuery} options={productOptions} allowFreeText={false} ariaLabel="Filter pending POs by product code"
        onChange={value => { setProductQuery(value); setPage(1); }} placeholder="All products" /></label>
      {(query || vendorQuery || productQuery) && <button className="wf-btn wf-btn-ghost wf-btn-sm" type="button"
        onClick={() => { setQuery(''); setVendorQuery(''); setProductQuery(''); setPage(1); }}>Clear filters</button>}
      <p className={styles.muted} role="status">{filtered.length} PO/product combinations across {new Set(filtered.map(source => source.po_number)).size} POs</p>
    </div>
    <div className={`${styles.scroll} ${styles.pendingPoScroll}`} role="region" aria-label="Scrollable pending POs" tabIndex={0}>
      <table className={`${styles.table} ${styles.pendingPoTable}`}>
        <caption className={styles.srOnly}>Pending POs by purchase order and product code</caption>
        <thead><tr><th>PO No.</th><th>Vendor</th><th>Product Code</th><th>Pending Quantity</th><th>Earliest Delivery Date</th><th>Cost/piece</th><th>Action</th></tr></thead>
        <tbody>{[...groups].map(([po, sources]) => <Fragment key={po}>{sources.map((source, index) => <tr key={productKey(source)}>
          {index === 0 && <td rowSpan={sources.length}>{source.po_ref_num || po}{source.po_ref_num && source.po_ref_num !== po && <small className={styles.pendingPoNumber}>{po}</small>}</td>}
          <td>{source.vendor_name || 'N/A'}</td><td><strong>{source.product_code}</strong></td>
          <td>{number(source.pending_qty)}</td><td>{source.expected_delivery_date || 'N/A'}</td>
          <td>{source.item_price == null ? 'N/A' : number(source.item_price)}</td>
          <td><button className="wf-btn wf-btn-ghost wf-btn-sm" type="button" disabled={disabled || remaining < 1}
            title={remaining < 1 ? 'The schedule has reached its 500-line limit.' : undefined}
            aria-label={'Add ' + source.product_code + ' from ' + source.po_number + ' to Inward Plan'}
            onClick={() => add(source)}>Add to Inward Plan</button></td>
        </tr>)}</Fragment>)}</tbody>
      </table>
      {!filtered.length && <p className={styles.muted}>No pending POs match this search.</p>}
    </div>
    <nav className={styles.buttons} aria-label="Pending POs pages">
      <button className="wf-btn wf-btn-ghost wf-btn-sm" type="button" disabled={currentPage <= 1} onClick={() => setPage(currentPage - 1)}>Previous</button>
      <span className={styles.muted}>Page {currentPage} of {pages}</span>
      <button className="wf-btn wf-btn-ghost wf-btn-sm" type="button" disabled={currentPage >= pages} onClick={() => setPage(currentPage + 1)}>Next</button>
    </nav>
  </section>;
}

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
    <p className={styles.muted}>Use current inventory and demand to decide what should be inwarded. Main Warehouse; DOQ = 45-day daily order quantity; DOH = Current Stock / DOQ. Cumulative DOQ sums all sizes of the variant; cumulative DOH = total variant stock / cumulative DOQ, in days. Missing inputs or zero DOQ make DOH unavailable (N/A).</p>
    <div className={`${styles.scroll} ${styles.inventoryScroll}`} role="region" aria-label="Scrollable inventory view" tabIndex={0}><table className={`${styles.table} ${styles.inventory}`}>
      <caption className={styles.srOnly}>Inventory by product, variant and size</caption>
      <thead><tr><th>Product Code</th><th>Variant Code</th><th>Size</th>{INVENTORY_SIZES.map(size => <th key={size}>{size}</th>)}<th>Cumulative DOQ</th><th>Cumulative DOH</th><th>View PO Detail</th></tr></thead>
      <tbody>{[...products].map(([product, variants]) => [...variants].map(([variant, sources], index) => {
        const inventory = sources[0].inventory ?? [];
        const cumulative = variantInventoryTotals(inventory);
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
          {metric === 0 && <>
            <td rowSpan={3}>{cumulative.doq == null ? 'N/A' : inventoryNumber.format(cumulative.doq)}</td>
            <td rowSpan={3}>{cumulative.doh == null ? 'N/A' : inventoryNumber.format(cumulative.doh)}</td>
            <td rowSpan={3}><button className="wf-btn wf-btn-ghost wf-btn-sm" type="button" aria-haspopup="dialog" aria-expanded={selected === keyOf(product, variant)} onClick={() => setSelected(selected === keyOf(product, variant) ? null : keyOf(product, variant))}>View PO Detail<span className={styles.srOnly}> for {variant}</span></button></td>
          </>}
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
