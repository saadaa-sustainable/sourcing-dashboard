'use client';

import { useMemo, useState, useTransition } from 'react';
import { CalendarCheck, FileCheck, Save, Send } from 'lucide-react';
import {
  confirmTna,
  issuePoApproval,
  savePoApproval,
  submitPoApproval,
} from '@/lib/forms/actions';
import { canApprove, canEdit, canSubmit } from '@/lib/forms/approval';
import { Field, Notice, StatusBadge } from '@/components/forms/form-layout';
import type {
  PoApproval,
  PoCategory,
  PoCycleTime,
  PoType,
  SdRole,
} from '@/lib/forms/types';

const PO_TYPES: { value: PoType; label: string }[] = [
  { value: 'FOB', label: 'FOB' },
  { value: 'job_work', label: 'Job Work' },
  { value: 'efob', label: 'E-FOB' },
];
const CATEGORIES: { value: PoCategory; label: string; hint: string }[] = [
  { value: 'fg', label: 'FG (finished goods)', hint: 'Checks TNA + vendor allocation · ≤5000 team, >5000 admin' },
  { value: 'mat', label: 'Material / Fabric', hint: 'Checks quantity · 2-level (admin) always' },
  { value: 'npd', label: 'NPD', hint: 'Checks cost · 2-level (admin) always' },
];

const BLANK = {
  po_type: '' as PoType | '',
  category: 'fg' as PoCategory,
  product_code: '',
  po_ref_num: '',
  vendor_code: '',
  vendor_name: '',
  tna_sheet_url: '',
  cost_sheet_url: '',
  po_qty: '',
  po_closing_date: '',
  cad_folder_url: '',
  cs_pp_sample_due: '',
  cs_gpt_due: '',
  cs_cutting_start: '',
  cs_inline_qc_due: '',
  critical_path_first_delivery: '',
  trim_card_signed: 'false',
  buying_plan_no: '',
};

const catLabel = (c: PoCategory) =>
  c === 'fg' ? 'FG' : c === 'mat' ? 'MAT' : 'NPD';

export function PoApprovalClient({
  pos,
  cycle,
  capacity,
  productCodes,
  vendorCodes,
  role,
}: {
  pos: PoApproval[];
  cycle: Record<string, PoCycleTime>;
  capacity: Record<string, number>;
  productCodes: string[];
  vendorCodes: string[];
  role: SdRole;
}) {
  const editable = canEdit(role, 'draft');
  const [form, setForm] = useState({ ...BLANK });
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pending, start] = useTransition();

  const set = (k: keyof typeof BLANK, v: string) =>
    setForm((f) => ({ ...f, [k]: v }));

  // Auto-suggest the PO ref in the observed standard format
  // FY<yy>-<yy+1>/<TYPE>/<PRODUCT>/<VENDOR>- (sequence appended manually for now).
  // Falls back to manual entry — the exact numbering rule is still to be confirmed.
  function suggestRef() {
    const d = new Date();
    const fyStart = d.getMonth() >= 3 ? d.getFullYear() : d.getFullYear() - 1;
    const yy = String(fyStart).slice(2);
    const yy2 = String(fyStart + 1).slice(2);
    const typeTok =
      form.po_type === 'job_work' ? 'JOB' : form.po_type === 'efob' ? 'EFOB' : 'FOB';
    set(
      'po_ref_num',
      `FY${yy}-${yy2}/${typeTok}/${form.product_code}/${form.vendor_code.toUpperCase()}-`,
    );
  }

  const buildPayload = () => {
    const p = new FormData();
    Object.entries(form).forEach(([k, v]) => p.set(k, v));
    return p;
  };

  // Save creates/keeps a draft. Submit saves first, then routes it for approval.
  function run(submitAfter: boolean) {
    setError(null);
    setMessage(null);
    start(async () => {
      const saved = await savePoApproval(buildPayload());
      if (!saved.ok) return setError(saved.error);
      if (submitAfter && saved.id) {
        const sub = new FormData();
        sub.set('id', String(saved.id));
        const res = await submitPoApproval(sub);
        if (!res.ok) return setError(res.error);
        setMessage(res.message ?? 'Submitted.');
      } else {
        setMessage(saved.message ?? 'Saved.');
      }
      setForm({ ...BLANK });
      window.location.reload();
    });
  }

  const liveLoad = form.vendor_code
    ? capacity[form.vendor_code.toLowerCase()]
    : undefined;
  const activeCat = CATEGORIES.find((c) => c.value === form.category);

  return (
    <>
      <Notice tone="info">
        The approval gate before a PO is issued on EasyCom — every PO written and
        visible, with the vendor’s live capacity on the approver’s card. After
        approval, enter the EasyCom PO number to tie it back to real data.
      </Notice>

      {message && <Notice tone="ok">{message}</Notice>}
      {error && <Notice tone="error">{error}</Notice>}

      <ReportingScreen pos={pos} />

      <CycleKpis cycle={cycle} />

      {editable && (
        <div className="panel wf-form-panel">
          <div className="panel-title">
            <h3>Raise a PO for approval</h3>
          </div>
          <div className="wf-form-grid">
            <Field label="Category" hint={activeCat?.hint}>
              <select
                value={form.category}
                onChange={(e) => set('category', e.target.value)}
              >
                {CATEGORIES.map((c) => (
                  <option key={c.value} value={c.value}>
                    {c.label}
                  </option>
                ))}
              </select>
            </Field>
            <Field label="PO type">
              <select
                value={form.po_type}
                onChange={(e) => set('po_type', e.target.value)}
              >
                <option value="">Select…</option>
                {PO_TYPES.map((t) => (
                  <option key={t.value} value={t.value}>
                    {t.label}
                  </option>
                ))}
              </select>
            </Field>
            <Field label="Product code">
              <input
                list="po-product-codes"
                value={form.product_code}
                placeholder="Select or type…"
                onChange={(e) => set('product_code', e.target.value)}
              />
              <datalist id="po-product-codes">
                {productCodes.map((c) => (
                  <option key={c} value={c} />
                ))}
              </datalist>
            </Field>
            <Field
              label="PO reference number"
              hint="Suggest builds the standard code — edit or type your own"
            >
              <div className="wf-issue-row">
                <input
                  value={form.po_ref_num}
                  placeholder="e.g. FY26-27/FOB/SDRPT/REG-01"
                  onChange={(e) => set('po_ref_num', e.target.value)}
                />
                <button
                  type="button"
                  className="wf-btn wf-btn-ghost wf-btn-sm"
                  onClick={suggestRef}
                  disabled={!form.po_type || !form.product_code || !form.vendor_code}
                  title="Auto-generate in the standard format"
                >
                  Suggest
                </button>
              </div>
            </Field>
            <Field
              label="Vendor code"
              hint={
                liveLoad != null
                  ? `Live load: ${liveLoad.toLocaleString('en-IN')} pcs in process`
                  : 'Live capacity shown on approval'
              }
            >
              <input
                list="po-vendor-codes"
                value={form.vendor_code}
                placeholder="Select or type…"
                onChange={(e) => set('vendor_code', e.target.value)}
              />
              <datalist id="po-vendor-codes">
                {vendorCodes.map((c) => (
                  <option key={c} value={c} />
                ))}
              </datalist>
            </Field>
            <Field label="Vendor name">
              <input
                value={form.vendor_name}
                placeholder="Optional"
                onChange={(e) => set('vendor_name', e.target.value)}
              />
            </Field>
            <Field label="TNA sheet link" hint="Google Drive">
              <input
                value={form.tna_sheet_url}
                placeholder="https://…"
                onChange={(e) => set('tna_sheet_url', e.target.value)}
              />
            </Field>
            <Field label="Cost sheet link">
              <input
                value={form.cost_sheet_url}
                placeholder="https://…"
                onChange={(e) => set('cost_sheet_url', e.target.value)}
              />
            </Field>
            <Field label="PO quantity" hint="Drives approval routing">
              <input
                type="number"
                min={0}
                value={form.po_qty}
                onChange={(e) => set('po_qty', e.target.value)}
              />
            </Field>
            <Field label="PO closing date" hint="As per TNA">
              <input
                type="date"
                value={form.po_closing_date}
                onChange={(e) => set('po_closing_date', e.target.value)}
              />
            </Field>
            {form.po_type === 'efob' && (
              <Field label="CAD file folder link" hint="EFOB POs only">
                <input
                  value={form.cad_folder_url}
                  placeholder="https://…"
                  onChange={(e) => set('cad_folder_url', e.target.value)}
                />
              </Field>
            )}
            <Field label="Critical stage — PP sample due">
              <input
                type="date"
                value={form.cs_pp_sample_due}
                onChange={(e) => set('cs_pp_sample_due', e.target.value)}
              />
            </Field>
            <Field label="Critical stage — GPT due">
              <input
                type="date"
                value={form.cs_gpt_due}
                onChange={(e) => set('cs_gpt_due', e.target.value)}
              />
            </Field>
            <Field label="Critical stage — Cutting start">
              <input
                type="date"
                value={form.cs_cutting_start}
                onChange={(e) => set('cs_cutting_start', e.target.value)}
              />
            </Field>
            <Field label="Critical stage — Inline QC due">
              <input
                type="date"
                value={form.cs_inline_qc_due}
                onChange={(e) => set('cs_inline_qc_due', e.target.value)}
              />
            </Field>
            <Field label="Critical path — first delivery">
              <input
                type="date"
                value={form.critical_path_first_delivery}
                onChange={(e) => set('critical_path_first_delivery', e.target.value)}
              />
            </Field>
            <Field label="Buying plan no." hint="Links back to the buying plan">
              <input
                value={form.buying_plan_no}
                placeholder="e.g. BP-JUL-2026"
                onChange={(e) => set('buying_plan_no', e.target.value)}
              />
            </Field>
            <label className="field wf-field wf-check-field">
              <span>Trim card signed</span>
              <input
                type="checkbox"
                checked={form.trim_card_signed === 'true'}
                onChange={(e) =>
                  set('trim_card_signed', e.target.checked ? 'true' : 'false')
                }
              />
            </label>
          </div>
          <div className="wf-footer-actions">
            <button
              type="button"
              className="wf-btn wf-btn-ghost"
              onClick={() => run(false)}
              disabled={pending}
            >
              <Save size={15} /> {pending ? 'Working…' : 'Save draft'}
            </button>
            <button
              type="button"
              className="wf-btn wf-btn-primary"
              onClick={() => run(true)}
              disabled={pending || !form.product_code || !Number(form.po_qty)}
            >
              <Send size={15} /> {pending ? 'Working…' : 'Save & submit'}
            </button>
          </div>
        </div>
      )}

      <div className="table-panel">
        <div className="table-meta">
          <h3>Purchase orders</h3>
          <span>{pos.length} total</span>
        </div>
        <div className="table-scroll">
          <table className="wide-table">
            <thead>
              <tr>
                <th>PO ref</th>
                <th>Category</th>
                <th>Product</th>
                <th>Vendor (live load)</th>
                <th>Qty</th>
                <th>Status</th>
                <th>Cycle (days)</th>
                <th>Action</th>
              </tr>
            </thead>
            <tbody>
              {pos.map((po) => (
                <PoRow
                  key={po.id}
                  po={po}
                  cycle={cycle[String(po.id)]}
                  liveLoad={
                    po.vendor_code
                      ? capacity[po.vendor_code.toLowerCase()]
                      : undefined
                  }
                  role={role}
                />
              ))}
              {!pos.length && (
                <tr>
                  <td colSpan={8} className="wf-empty-cell">
                    No POs raised yet.
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </div>
    </>
  );
}

/** Reporting screen (sheet REQ rows 14-15): issued last week / to issue this week. */
function ReportingScreen({ pos }: { pos: PoApproval[] }) {
  const { issued, toIssue } = useMemo(() => {
    const weekAgo = Date.now() - 7 * 86_400_000;
    const issued = pos.filter(
      (p) => p.po_issued_at && new Date(p.po_issued_at).getTime() >= weekAgo,
    );
    // Approved but not yet issued — the queue of POs still to go out.
    const toIssue = pos.filter((p) => p.status === 'approved' && !p.easycom_po_no);
    return { issued, toIssue };
  }, [pos]);

  return (
    <div className="wf-report-grid">
      <ReportCard title="POs issued last week" rows={issued} kind="issued" />
      <ReportCard title="POs to be issued this week" rows={toIssue} kind="toIssue" />
    </div>
  );
}

function ReportCard({
  title,
  rows,
  kind,
}: {
  title: string;
  rows: PoApproval[];
  kind: 'issued' | 'toIssue';
}) {
  return (
    <div className="panel wf-report-card">
      <div className="panel-title">
        <h3>{title}</h3>
        <span className="wf-report-count">{rows.length}</span>
      </div>
      {rows.length ? (
        <ul className="wf-report-list">
          {rows.slice(0, 8).map((p) => (
            <li key={p.id}>
              <span className="mono">{p.po_ref_num ?? `#${p.id}`}</span>
              <span className="wf-subtle">
                {catLabel(p.category)} · {p.vendor_name || p.vendor_code || '—'} ·{' '}
                {Number(p.po_qty).toLocaleString('en-IN')} pcs
              </span>
              <span className="wf-subtle">
                {kind === 'issued'
                  ? p.po_issued_at
                    ? new Date(p.po_issued_at).toLocaleDateString('en-IN')
                    : ''
                  : p.po_closing_date
                    ? `close ${new Date(p.po_closing_date).toLocaleDateString('en-IN')}`
                    : ''}
              </span>
            </li>
          ))}
        </ul>
      ) : (
        <p className="wf-subtle wf-report-empty">Nothing here.</p>
      )}
    </div>
  );
}

/**
 * Approval cycle-time KPI — rolling averages across POs, distinct from the TNA-stage
 * delay numbers. Submission → approval → vendor sign-off (the DiGiO signed date).
 */
function CycleKpis({ cycle }: { cycle: Record<string, PoCycleTime> }) {
  const rows = Object.values(cycle);
  const avg = (pick: (c: PoCycleTime) => number | null) => {
    const vals = rows.map(pick).filter((v): v is number => v != null);
    if (!vals.length) return null;
    return Math.round((vals.reduce((s, v) => s + v, 0) / vals.length) * 10) / 10;
  };
  const toApprove = avg((c) => c.days_to_approve);
  const toSign = avg((c) => c.days_to_sign);
  const total = avg((c) => c.total_cycle_days_signoff ?? c.total_cycle_days);
  const measured = rows.filter((c) => c.days_to_approve != null).length;
  const fmtDays = (v: number | null) => (v == null ? '—' : `${v}d`);

  return (
    <div className="wf-kpi-strip">
      <div className="wf-kpi">
        <span className="wf-kpi-label">Submission → approval</span>
        <strong className="wf-kpi-value">{fmtDays(toApprove)}</strong>
      </div>
      <div className="wf-kpi">
        <span className="wf-kpi-label">Approval → sign-off</span>
        <strong className="wf-kpi-value">{fmtDays(toSign)}</strong>
      </div>
      <div className="wf-kpi">
        <span className="wf-kpi-label">End-to-end</span>
        <strong className="wf-kpi-value">{fmtDays(total)}</strong>
      </div>
      <div className="wf-kpi">
        <span className="wf-kpi-label">POs measured</span>
        <strong className="wf-kpi-value">{measured}</strong>
      </div>
      <p className="wf-kpi-note">
        Average PO approval cycle — separate from TNA-stage production delays.
      </p>
    </div>
  );
}

function PoRow({
  po,
  cycle,
  liveLoad,
  role,
}: {
  po: PoApproval;
  cycle?: PoCycleTime;
  liveLoad?: number;
  role: SdRole;
}) {
  const [error, setError] = useState<string | null>(null);
  const [pending, start] = useTransition();
  const [signing, setSigning] = useState(false);
  const [iss, setIss] = useState({
    easycom_po_no: po.easycom_po_no ?? '',
    first_actual_delivery_date: po.first_actual_delivery_date ?? '',
    signed_po_document_url: po.signed_po_document_url ?? '',
    signed_cost_sheet_url: po.signed_cost_sheet_url ?? '',
    signed_tna_url: po.signed_tna_url ?? '',
    signed_po_ref_number: po.signed_po_ref_number ?? '',
    date_of_po_sign: po.date_of_po_sign ?? '',
  });
  const setI = (k: keyof typeof iss, v: string) => setIss((s) => ({ ...s, [k]: v }));
  const [benchmark, setBenchmark] = useState(false);
  const canIssue = canEdit(role, 'draft');
  const issued = Boolean(po.po_issued_at);

  // TNA gate — only this PO's approver may review/lock the critical-path dates.
  const isApprover =
    (po.status === 'submitted' || po.status === 'pending_l2') &&
    canApprove(role, po.status);
  const [tnaOpen, setTnaOpen] = useState(false);
  const [tna, setTna] = useState({
    po_closing_date: po.po_closing_date ?? '',
    cs_pp_sample_due: po.cs_pp_sample_due ?? '',
    cs_gpt_due: po.cs_gpt_due ?? '',
    cs_cutting_start: po.cs_cutting_start ?? '',
    cs_inline_qc_due: po.cs_inline_qc_due ?? '',
    critical_path_first_delivery: po.critical_path_first_delivery ?? '',
  });
  const setT = (k: keyof typeof tna, v: string) => setTna((s) => ({ ...s, [k]: v }));

  function confirmTnaDates() {
    setError(null);
    const p = new FormData();
    p.set('id', String(po.id));
    Object.entries(tna).forEach(([k, v]) => p.set(k, v));
    start(async () => {
      const res = await confirmTna(p);
      if (res.ok) window.location.reload();
      else setError(res.error);
    });
  }

  function submit() {
    setError(null);
    const p = new FormData();
    p.set('id', String(po.id));
    start(async () => {
      const res = await submitPoApproval(p);
      if (res.ok) window.location.reload();
      else setError(res.error);
    });
  }

  function saveIssuance() {
    setError(null);
    const p = new FormData();
    p.set('id', String(po.id));
    Object.entries(iss).forEach(([k, v]) => p.set(k, v));
    p.set('set_benchmark', benchmark ? 'true' : 'false');
    start(async () => {
      const res = await issuePoApproval(p);
      if (res.ok) window.location.reload();
      else setError(res.error);
    });
  }

  return (
    <>
      <tr className={signing || tnaOpen ? 'wf-row-open' : ''}>
        <td className="mono">{po.po_ref_num ?? `#${po.id}`}</td>
        <td>{catLabel(po.category)}</td>
        <td className="mono">{po.product_code ?? '—'}</td>
        <td>
          {po.vendor_name || po.vendor_code || '—'}
          {po.vendor_code && (
            <small className="wf-subtle">
              {liveLoad == null
                ? 'no open POs'
                : `${liveLoad.toLocaleString('en-IN')} pcs in process`}
            </small>
          )}
        </td>
        <td>{Number(po.po_qty).toLocaleString('en-IN')}</td>
        <td>
          <StatusBadge status={po.status} />
          {(po.status === 'submitted' || po.status === 'pending_l2') && (
            <small className={po.tna_confirmed ? 'wf-tna-ok' : 'wf-tna-pending'}>
              {po.tna_confirmed ? 'TNA confirmed' : 'TNA pending'}
            </small>
          )}
          {po.status === 'rejected' && po.rejection_notes && (
            <small className="wf-subtle">{po.rejection_notes}</small>
          )}
          {po.easycom_po_no && (
            <small className="wf-subtle">EasyCom {po.easycom_po_no}</small>
          )}
        </td>
        <td className="wf-subtle">
          {cycle?.total_cycle_days != null
            ? `${cycle.total_cycle_days} total`
            : cycle?.days_to_approve != null
              ? `${cycle.days_to_approve} to approve`
              : '—'}
          {cycle?.days_to_sign != null && (
            <small className="wf-subtle">{cycle.days_to_sign}d to sign</small>
          )}
        </td>
        <td>
          {error && <small className="wf-subtle wf-error-text">{error}</small>}
          {po.status === 'draft' && canSubmit(role, po.status) && (
            <button
              type="button"
              className="wf-btn wf-btn-primary wf-btn-sm"
              onClick={submit}
              disabled={pending}
            >
              <Send size={14} /> Submit
            </button>
          )}
          {(po.status === 'submitted' || po.status === 'pending_l2') &&
            (isApprover ? (
              po.tna_confirmed ? (
                // Approve / Reject / Rework happen only in the Approvals queue — not
                // inline here — so admin decisions route through one place.
                <a className="wf-btn wf-btn-ghost wf-btn-sm" href="/approvals">
                  Decide in Approvals &rarr;
                </a>
              ) : (
                <button
                  type="button"
                  className="wf-btn wf-btn-primary wf-btn-sm"
                  onClick={() => setTnaOpen((v) => !v)}
                >
                  <CalendarCheck size={14} /> Review &amp; confirm TNA
                </button>
              )
            ) : (
              <span className="wf-subtle">Awaiting approval</span>
            ))}
          {po.status === 'approved' && canIssue && (
            <button
              type="button"
              className="wf-btn wf-btn-primary wf-btn-sm"
              onClick={() => setSigning((v) => !v)}
            >
              <FileCheck size={14} /> {issued ? 'Signing' : 'Issue / sign'}
            </button>
          )}
          {po.status === 'approved' && !canIssue && issued && (
            <span className="wf-subtle">Issued</span>
          )}
        </td>
      </tr>
      {tnaOpen && isApprover && (
        <tr className="wf-issue-panel-row">
          <td colSpan={8}>
            <div className="wf-issue-panel">
              <strong className="wf-issue-title">
                Review &amp; confirm TNA — {po.po_ref_num ?? `PO #${po.id}`}
              </strong>
              <p className="wf-subtle">
                Check these critical-path dates make sense for the quantity (
                {Number(po.po_qty).toLocaleString('en-IN')} pcs). Cost approval stays
                blocked until you confirm — confirming locks them as the approved TNA.
              </p>
              <div className="wf-form-grid">
                <Field label="PO closing date">
                  <input
                    type="date"
                    value={tna.po_closing_date}
                    onChange={(e) => setT('po_closing_date', e.target.value)}
                  />
                </Field>
                <Field label="PP sample due">
                  <input
                    type="date"
                    value={tna.cs_pp_sample_due}
                    onChange={(e) => setT('cs_pp_sample_due', e.target.value)}
                  />
                </Field>
                <Field label="GPT due">
                  <input
                    type="date"
                    value={tna.cs_gpt_due}
                    onChange={(e) => setT('cs_gpt_due', e.target.value)}
                  />
                </Field>
                <Field label="Cutting start">
                  <input
                    type="date"
                    value={tna.cs_cutting_start}
                    onChange={(e) => setT('cs_cutting_start', e.target.value)}
                  />
                </Field>
                <Field label="Inline QC due">
                  <input
                    type="date"
                    value={tna.cs_inline_qc_due}
                    onChange={(e) => setT('cs_inline_qc_due', e.target.value)}
                  />
                </Field>
                <Field label="First delivery (critical path)">
                  <input
                    type="date"
                    value={tna.critical_path_first_delivery}
                    onChange={(e) => setT('critical_path_first_delivery', e.target.value)}
                  />
                </Field>
              </div>
              <div className="wf-footer-actions">
                <button
                  type="button"
                  className="wf-btn wf-btn-primary wf-btn-sm"
                  onClick={confirmTnaDates}
                  disabled={pending}
                >
                  <CalendarCheck size={14} />{' '}
                  {po.tna_confirmed ? 'Re-confirm TNA' : 'Confirm TNA & unblock cost'}
                </button>
                <button
                  type="button"
                  className="wf-btn wf-btn-ghost wf-btn-sm"
                  onClick={() => setTnaOpen(false)}
                >
                  Close
                </button>
              </div>
            </div>
          </td>
        </tr>
      )}
      {signing && po.status === 'approved' && canIssue && (
        <tr className="wf-issue-panel-row">
          <td colSpan={8}>
            <div className="wf-issue-panel">
              <strong className="wf-issue-title">
                Issue &amp; sign — {po.po_ref_num ?? `PO #${po.id}`}
              </strong>
              <div className="wf-form-grid">
                <Field label="EasyCom PO no." hint="Maps to the real PO — required to issue">
                  <input
                    value={iss.easycom_po_no}
                    placeholder="EasyCom PO #"
                    onChange={(e) => setI('easycom_po_no', e.target.value)}
                  />
                </Field>
                <Field label="First actual delivery date" hint="EasyCom">
                  <input
                    type="date"
                    value={iss.first_actual_delivery_date}
                    onChange={(e) => setI('first_actual_delivery_date', e.target.value)}
                  />
                </Field>
                <Field label="Signed PO document" hint="DiGiO — URL for now">
                  <input
                    value={iss.signed_po_document_url}
                    placeholder="https://…"
                    onChange={(e) => setI('signed_po_document_url', e.target.value)}
                  />
                </Field>
                <Field label="Signed cost sheet" hint="DiGiO — URL for now">
                  <input
                    value={iss.signed_cost_sheet_url}
                    placeholder="https://…"
                    onChange={(e) => setI('signed_cost_sheet_url', e.target.value)}
                  />
                </Field>
                <Field label="Signed TNA" hint="DiGiO — URL for now">
                  <input
                    value={iss.signed_tna_url}
                    placeholder="https://…"
                    onChange={(e) => setI('signed_tna_url', e.target.value)}
                  />
                </Field>
                <Field label="Signed PO ref number" hint="DiGiO">
                  <input
                    value={iss.signed_po_ref_number}
                    onChange={(e) => setI('signed_po_ref_number', e.target.value)}
                  />
                </Field>
                <Field label="Date of PO sign" hint="DiGiO">
                  <input
                    type="date"
                    value={iss.date_of_po_sign}
                    onChange={(e) => setI('date_of_po_sign', e.target.value)}
                  />
                </Field>
              </div>
              <label className="wf-check-field wf-benchmark">
                <input
                  type="checkbox"
                  checked={benchmark}
                  onChange={(e) => setBenchmark(e.target.checked)}
                />
                <span>
                  Set as <strong>standard benchmark cost</strong> — freezes this
                  product’s standard cost as the fixed reference (no later drift).
                </span>
              </label>
              <div className="wf-footer-actions">
                <button
                  type="button"
                  className="wf-btn wf-btn-primary wf-btn-sm"
                  onClick={saveIssuance}
                  disabled={pending || (!issued && !iss.easycom_po_no.trim())}
                >
                  <FileCheck size={14} />{' '}
                  {issued ? 'Save signing details' : 'Issue PO'}
                </button>
                <button
                  type="button"
                  className="wf-btn wf-btn-ghost wf-btn-sm"
                  onClick={() => setSigning(false)}
                >
                  Close
                </button>
              </div>
            </div>
          </td>
        </tr>
      )}
    </>
  );
}
