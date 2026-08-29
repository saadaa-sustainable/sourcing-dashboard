'use client';

import { Fragment, useMemo, useState, useTransition } from 'react';
import { reloadWithToast } from '@/lib/toast';
import { CalendarCheck, CheckCircle, FileCheck, Layers, Save, Send, X } from 'lucide-react';
import {
  confirmTna,
  issuePoApproval,
  savePoApproval,
  savePoLines,
  saveTnaLeadtimes,
  setPoClosure,
  submitPoApproval,
} from '@/lib/forms/actions';
import { canApprove, canEdit, canSubmit } from '@/lib/forms/approval';
import { Field, Notice, StatusBadge } from '@/components/forms/form-layout';
import type {
  PoApproval,
  PoApprovalLine,
  PoCategory,
  PoCycleTime,
  PoSubmissionGroup,
  PoType,
  SdRole,
  TnaLeadtimes,
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
  rate: '',
  // Per-PO cost pivot (spec §5): commodity params (informational) + CM (gated).
  grey_cost: '',
  finished_fabric_cost: '',
  cm_cost: '',
  margin_pct: '',
  po_qty: '',
  po_closing_date: '',
  cad_folder_url: '',
  cs_pp_sample_due: '',
  cs_gpt_due: '',
  cs_cutting_start: '',
  cs_inline_qc_due: '',
  critical_path_first_delivery: '',
  buying_plan_no: '',
};

const catLabel = (c: PoCategory) =>
  c === 'fg' ? 'FG' : c === 'mat' ? 'MAT' : 'NPD';

// A stage date on the critical path = the TNA start date + its lead-time offset.
function addDays(iso: string, n: number | null | undefined): string {
  if (!iso || n == null) return '';
  const d = new Date(`${iso}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

export function PoApprovalClient({
  pos,
  cycle,
  linesByPo,
  capacity,
  productCodes,
  vendorCodes,
  vendorNames = {},
  submissions = [],
  leadtimes,
  stdCm = {},
  role,
}: {
  pos: PoApproval[];
  cycle: Record<string, PoCycleTime>;
  linesByPo: Record<string, PoApprovalLine[]>;
  capacity: Record<string, number>;
  productCodes: string[];
  vendorCodes: string[];
  vendorNames?: Record<string, string>;
  submissions?: PoSubmissionGroup[];
  leadtimes?: TnaLeadtimes;
  stdCm?: Record<string, number>;
  role: SdRole;
}) {
  const editable = canEdit(role, 'draft');
  const [form, setForm] = useState({ ...BLANK });
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pending, start] = useTransition();

  const set = (k: keyof typeof BLANK, v: string) =>
    setForm((f) => ({ ...f, [k]: v }));

  // Vendor: code is primary, name auto-fills; and typing a name back-fills the
  // code. Both are shown together. Name → code reverse lookup off the master.
  const nameToCode = useMemo(() => {
    const m: Record<string, string> = {};
    for (const [code, name] of Object.entries(vendorNames)) if (name) m[name] = code;
    return m;
  }, [vendorNames]);
  const setVendorCode = (code: string) =>
    setForm((f) => ({ ...f, vendor_code: code, vendor_name: vendorNames[code.trim()] ?? f.vendor_name }));
  const setVendorName = (name: string) =>
    setForm((f) => ({ ...f, vendor_name: name, vendor_code: nameToCode[name.trim()] ?? f.vendor_code }));

  // TNA critical path auto-generates from a start date + the standard lead-times.
  const [tnaStart, setTnaStart] = useState('');
  function autoGenerateTna() {
    if (!tnaStart || !leadtimes) return;
    setForm((f) => ({
      ...f,
      cs_pp_sample_due: addDays(tnaStart, leadtimes.pp_sample_days),
      cs_gpt_due: addDays(tnaStart, leadtimes.gpt_days),
      cs_cutting_start: addDays(tnaStart, leadtimes.cutting_days),
      cs_inline_qc_due: addDays(tnaStart, leadtimes.inline_qc_days),
      critical_path_first_delivery: addDays(tnaStart, leadtimes.first_delivery_days),
      po_closing_date: addDays(tnaStart, leadtimes.po_closing_days),
    }));
    setMessage('Critical path generated from the lead-times — adjust any date if needed.');
  }

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
      reloadWithToast();
    });
  }

  const liveLoad = form.vendor_code
    ? capacity[form.vendor_code.toLowerCase()]
    : undefined;
  const activeCat = CATEGORIES.find((c) => c.value === form.category);
  // Standard CM for the typed product — pre-fills / hints the PO's CM (spec §5).
  const stdCmForProduct = form.product_code ? stdCm[form.product_code.trim()] : undefined;

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
                  : 'Pick a code — name fills itself'
              }
            >
              <input
                list="po-vendor-codes"
                value={form.vendor_code}
                placeholder="Select or type a code…"
                onChange={(e) => setVendorCode(e.target.value)}
              />
              <datalist id="po-vendor-codes">
                {vendorCodes.map((c) => (
                  <option key={c} value={c}>
                    {vendorNames[c] ? `${c} — ${vendorNames[c]}` : c}
                  </option>
                ))}
              </datalist>
            </Field>
            <Field label="Vendor name" hint="auto-fills from the code (or pick to back-fill the code)">
              <input
                list="po-vendor-names"
                value={form.vendor_name}
                placeholder="Auto from code…"
                onChange={(e) => setVendorName(e.target.value)}
              />
              <datalist id="po-vendor-names">
                {Object.values(vendorNames)
                  .filter(Boolean)
                  .map((n) => (
                    <option key={n} value={n} />
                  ))}
              </datalist>
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
            <Field label="Rate" hint="filled with the cost sheet — required to submit">
              <input
                type="number"
                min={0}
                value={form.rate}
                placeholder="e.g. 265"
                onChange={(e) => set('rate', e.target.value)}
              />
            </Field>
            <Field
              label="CMTP cost (this PO)"
              hint={
                stdCmForProduct != null
                  ? `standard CMTP ${stdCmForProduct}`
                  : 'the FINAL CMTP figure for this PO'
              }
            >
              <div className="wf-issue-row">
                <input
                  type="number"
                  min={0}
                  value={form.cm_cost}
                  placeholder="e.g. 92"
                  onChange={(e) => set('cm_cost', e.target.value)}
                />
                {stdCmForProduct != null && (
                  <button
                    type="button"
                    className="wf-btn wf-btn-ghost wf-btn-sm"
                    title="Fill with the standard CMTP"
                    onClick={() => set('cm_cost', String(stdCmForProduct))}
                  >
                    Use standard
                  </button>
                )}
              </div>
            </Field>
            <Field label="Grey cost (this PO)" hint="commodity — informational, not gated">
              <input
                type="number"
                min={0}
                value={form.grey_cost}
                placeholder="e.g. 270"
                onChange={(e) => set('grey_cost', e.target.value)}
              />
            </Field>
            <Field label="Finished fabric cost (this PO)" hint="commodity — informational">
              <input
                type="number"
                min={0}
                value={form.finished_fabric_cost}
                placeholder="e.g. 180"
                onChange={(e) => set('finished_fabric_cost', e.target.value)}
              />
            </Field>
            <Field label="Margin %" hint="optional">
              <input
                type="number"
                min={0}
                value={form.margin_pct}
                placeholder="e.g. 5"
                onChange={(e) => set('margin_pct', e.target.value)}
              />
            </Field>
            <Field label="PO quantity" hint="= sum of size lines (add them on the row after saving)">
              <input type="number" value={form.po_qty} readOnly disabled />
            </Field>
            <Field label="PO closing date" hint="As per TNA">
              <input
                type="date"
                value={form.po_closing_date}
                onChange={(e) => set('po_closing_date', e.target.value)}
              />
            </Field>
            {form.po_type === 'FOB' && (
              <Field label="CAD file folder link" hint="FOB POs only">
                <input
                  value={form.cad_folder_url}
                  placeholder="https://…"
                  onChange={(e) => set('cad_folder_url', e.target.value)}
                />
              </Field>
            )}
            <Field label="TNA start date" hint="auto-generates the critical path below">
              <div className="wf-issue-row">
                <input type="date" value={tnaStart} onChange={(e) => setTnaStart(e.target.value)} />
                <button
                  type="button"
                  className="wf-btn wf-btn-ghost wf-btn-sm"
                  onClick={autoGenerateTna}
                  disabled={!tnaStart || !leadtimes}
                  title="Fill the 6 critical-path dates from the standard lead-times"
                >
                  <CalendarCheck size={13} /> Auto-generate
                </button>
              </div>
            </Field>
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
          </div>
          <div className="wf-footer-actions">
            <p className="wf-footer-note">
              Save the draft, then add the size lines on its row (PO qty totals itself) and submit from
              there.
            </p>
            <button
              type="button"
              className="wf-btn wf-btn-primary"
              onClick={() => run(false)}
              disabled={pending || !form.product_code}
            >
              <Save size={15} /> {pending ? 'Working…' : 'Save draft'}
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
                  lines={linesByPo[String(po.id)] ?? []}
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

      <PoSubmissionTable submissions={submissions} editable={editable} />

      {editable && leadtimes && <TnaLeadtimesPanel leadtimes={leadtimes} />}
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
  lines,
  role,
}: {
  po: PoApproval;
  cycle?: PoCycleTime;
  liveLoad?: number;
  lines: PoApprovalLine[];
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
    trim_card_signed: po.trim_card_signed ? 'true' : 'false',
  });
  const setI = (k: keyof typeof iss, v: string) => setIss((s) => ({ ...s, [k]: v }));
  const [benchmark, setBenchmark] = useState(false);
  const canIssue = canEdit(role, 'draft');
  const issued = Boolean(po.po_issued_at);

  // Timeline-change flag: actual first delivery landing past the approved
  // first-delivery date is an "extended after approval" case — surfaced, not blocked.
  const timelineExtDays =
    po.first_actual_delivery_date && po.critical_path_first_delivery
      ? Math.round(
          (Date.parse(po.first_actual_delivery_date) -
            Date.parse(po.critical_path_first_delivery)) /
            86_400_000,
        )
      : null;

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

  // Colour/size line items — editable until the PO is approved.
  const linesEditable = po.status !== 'approved' && canIssue;
  const [linesOpen, setLinesOpen] = useState(false);
  const [lineRows, setLineRows] = useState(
    lines.map((l) => ({
      product_variant: l.product_variant ?? '',
      size: l.size ?? '',
      qty: l.qty != null ? String(l.qty) : '',
      line_status: l.line_status,
      rework_notes: l.rework_notes,
    })),
  );
  const patchLine = (i: number, k: 'product_variant' | 'size' | 'qty', v: string) =>
    setLineRows((rows) => rows.map((r, idx) => (idx === i ? { ...r, [k]: v } : r)));
  const addLine = () =>
    setLineRows((rows) => [
      ...rows,
      { product_variant: '', size: '', qty: '', line_status: null, rework_notes: null },
    ]);
  const removeLine = (i: number) => setLineRows((rows) => rows.filter((_, idx) => idx !== i));
  function saveLines() {
    setError(null);
    const p = new FormData();
    p.set('po_id', String(po.id));
    p.set(
      'lines',
      JSON.stringify(
        lineRows.map((r) => ({
          product_variant: r.product_variant,
          size: r.size,
          qty: Number(r.qty) || 0,
        })),
      ),
    );
    start(async () => {
      const res = await savePoLines(p);
      if (res.ok) reloadWithToast();
      else setError(res.error);
    });
  }

  function confirmTnaDates() {
    setError(null);
    const p = new FormData();
    p.set('id', String(po.id));
    Object.entries(tna).forEach(([k, v]) => p.set(k, v));
    start(async () => {
      const res = await confirmTna(p);
      if (res.ok) reloadWithToast();
      else setError(res.error);
    });
  }

  function submit() {
    setError(null);
    const p = new FormData();
    p.set('id', String(po.id));
    start(async () => {
      const res = await submitPoApproval(p);
      if (res.ok) reloadWithToast();
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
      if (res.ok) reloadWithToast();
      else setError(res.error);
    });
  }

  return (
    <>
      <tr className={signing || tnaOpen ? 'wf-row-open' : ''}>
        <td className="mono">{po.po_ref_num ?? `#${po.id}`}</td>
        <td>
          <span className={`wf-cat-chip wf-cat-${po.category}`}>{catLabel(po.category)}</span>
        </td>
        <td className="mono">{po.product_code ?? '—'}</td>
        <td>
          {po.vendor_code && po.vendor_name
            ? `${po.vendor_code.toUpperCase()} - ${po.vendor_name}`
            : po.vendor_name || po.vendor_code || '—'}
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
          {timelineExtDays != null && timelineExtDays > 0 && (
            <small
              className="wf-timeline-flag"
              title={`Actual first delivery ${po.first_actual_delivery_date} is ${timelineExtDays} day(s) past the approved ${po.critical_path_first_delivery}`}
            >
              ⚠ timeline +{timelineExtDays}d
            </small>
          )}
        </td>
        <td className="wf-subtle">
          {po.requested_total_days != null ? (
            <span title="Requested at submission — locked">{po.requested_total_days}d requested</span>
          ) : cycle?.total_cycle_days != null ? (
            `${cycle.total_cycle_days} total`
          ) : cycle?.days_to_approve != null ? (
            `${cycle.days_to_approve} to approve`
          ) : (
            '—'
          )}
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
          <button
            type="button"
            className="wf-btn wf-btn-ghost wf-btn-sm"
            onClick={() => setLinesOpen((v) => !v)}
          >
            <Layers size={14} /> Lines ({lineRows.length})
          </button>
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
              </div>
              <Notice tone="info">
                DiGiO e-signing (signed PO / cost sheet / TNA, sign date) is <strong>Phase 2</strong> —
                not captured here yet.
              </Notice>
              <label className="wf-check-field">
                <input
                  type="checkbox"
                  checked={iss.trim_card_signed === 'true'}
                  onChange={(e) =>
                    setI('trim_card_signed', e.target.checked ? 'true' : 'false')
                  }
                />
                <span>Trim card signed — captured at issuance, not before</span>
              </label>
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
      {linesOpen && (
        <tr className="wf-issue-panel-row">
          <td colSpan={8}>
            <div className="wf-issue-panel">
              <strong className="wf-issue-title">
                Colour / size lines — {po.po_ref_num ?? `PO #${po.id}`}
              </strong>
              <table className="wide-table wf-grid">
                <thead>
                  <tr>
                    <th>Colour / variant</th>
                    <th>Size</th>
                    <th className="num">Qty</th>
                    <th>Line status</th>
                    {linesEditable && <th aria-label="Remove" />}
                  </tr>
                </thead>
                <tbody>
                  {lineRows.map((ln, i) => (
                    <tr key={i}>
                      <td className="input-col">
                        <input
                          value={ln.product_variant}
                          disabled={!linesEditable}
                          onChange={(e) => patchLine(i, 'product_variant', e.target.value)}
                        />
                      </td>
                      <td className="input-col">
                        <input
                          value={ln.size}
                          disabled={!linesEditable}
                          onChange={(e) => patchLine(i, 'size', e.target.value)}
                        />
                      </td>
                      <td className="num input-col">
                        <input
                          type="number"
                          min={0}
                          value={ln.qty}
                          disabled={!linesEditable}
                          onChange={(e) => patchLine(i, 'qty', e.target.value)}
                        />
                      </td>
                      <td>
                        {ln.line_status === 'rework' ? (
                          <span className="wf-over-tag" title={ln.rework_notes ?? ''}>
                            rework
                          </span>
                        ) : (
                          <span className="wf-subtle">—</span>
                        )}
                      </td>
                      {linesEditable && (
                        <td>
                          <button
                            type="button"
                            className="wf-btn wf-btn-ghost wf-btn-sm"
                            onClick={() => removeLine(i)}
                          >
                            <X size={13} />
                          </button>
                        </td>
                      )}
                    </tr>
                  ))}
                  {!lineRows.length && (
                    <tr>
                      <td colSpan={linesEditable ? 5 : 4} className="wf-empty-cell">
                        No colour/size lines yet.
                      </td>
                    </tr>
                  )}
                </tbody>
              </table>
              {linesEditable ? (
                <div className="wf-footer-actions">
                  <button
                    type="button"
                    className="wf-btn wf-btn-ghost wf-btn-sm"
                    onClick={addLine}
                  >
                    Add line
                  </button>
                  <button
                    type="button"
                    className="wf-btn wf-btn-primary wf-btn-sm"
                    onClick={saveLines}
                    disabled={pending}
                  >
                    <Save size={14} /> Save lines
                  </button>
                  <button
                    type="button"
                    className="wf-btn wf-btn-ghost wf-btn-sm"
                    onClick={() => setLinesOpen(false)}
                  >
                    Close
                  </button>
                </div>
              ) : (
                <p className="wf-subtle">Read-only — this PO is approved.</p>
              )}
            </div>
          </td>
        </tr>
      )}
    </>
  );
}

const nfmt = (v: number) => v.toLocaleString('en-IN');

/**
 * PO submission / closure — the open (issued) POs below the main table, SKU-wise
 * expandable, with a simple row-wise Yes/No closure.
 */
function PoSubmissionTable({
  submissions,
  editable,
}: {
  submissions: PoSubmissionGroup[];
  editable: boolean;
}) {
  const [q, setQ] = useState('');
  const [open, setOpen] = useState<string | null>(null);
  const [busy, start] = useTransition();

  const shown = submissions.filter((s) =>
    q
      ? `${s.po_number} ${s.po_ref_num ?? ''} ${s.vendor_name ?? ''} ${s.product_codes.join(' ')}`
          .toLowerCase()
          .includes(q.trim().toLowerCase())
      : true,
  );

  function decide(po_number: string, decision: 'yes' | 'no') {
    const fd = new FormData();
    fd.set('po_number', po_number);
    fd.set('decision', decision);
    start(async () => {
      const res = await setPoClosure(fd);
      if (res.ok) reloadWithToast();
    });
  }

  return (
    <div className="panel">
      <div className="panel-title">
        <h3>PO submission &amp; closure</h3>
        <span>{submissions.length} open PO(s) · row-wise close</span>
      </div>
      <div className="wf-toolbar">
        <input
          className="wf-search"
          placeholder="Filter PO / vendor / product…"
          value={q}
          onChange={(e) => setQ(e.target.value)}
        />
      </div>
      <div className="table-panel">
        <div className="table-scroll">
          <table className="wide-table">
            <thead>
              <tr>
                <th />
                <th>PO</th>
                <th>Vendor</th>
                <th>Products</th>
                <th className="num">Ordered</th>
                <th className="num">Pending</th>
                <th>EDD</th>
                <th>Closure</th>
                {editable && <th aria-label="Decide" />}
              </tr>
            </thead>
            <tbody>
              {shown.map((s) => (
                <Fragment key={s.po_number}>
                  <tr className={open === s.po_number ? 'wf-row-open' : ''}>
                    <td>
                      <button
                        type="button"
                        className="wf-expand-btn"
                        aria-expanded={open === s.po_number}
                        aria-label="SKU breakdown"
                        onClick={() => setOpen(open === s.po_number ? null : s.po_number)}
                      >
                        {open === s.po_number ? '−' : '+'}
                      </button>
                    </td>
                    <td className="mono">
                      {s.po_number}
                      <small className="wf-subtle">{s.po_ref_num}</small>
                    </td>
                    <td>
                      {s.vendor_code && s.vendor_name
                        ? `${s.vendor_code.toUpperCase()} - ${s.vendor_name}`
                        : s.vendor_name || s.vendor_code || '—'}
                    </td>
                    <td className="mono">{s.product_codes.join(', ') || '—'}</td>
                    <td className="num">{nfmt(s.original_qty)}</td>
                    <td className="num strong">{nfmt(s.pending_qty)}</td>
                    <td className="wf-subtle">{s.expected_delivery_date ?? '—'}</td>
                    <td>
                      <StatusBadge status={s.closureStatus} />
                    </td>
                    {editable && (
                      <td>
                        <div className="wf-issue-row">
                          <button
                            type="button"
                            className="wf-btn wf-btn-ghost wf-btn-sm"
                            disabled={busy || s.closureStatus === 'approved'}
                            title="Close this PO"
                            onClick={() => decide(s.po_number, 'yes')}
                          >
                            <CheckCircle size={14} /> Yes
                          </button>
                          <button
                            type="button"
                            className="wf-btn wf-btn-ghost wf-btn-sm"
                            disabled={busy || s.closureStatus === 'rejected'}
                            title="Flag this PO"
                            onClick={() => decide(s.po_number, 'no')}
                          >
                            <X size={14} /> No
                          </button>
                        </div>
                      </td>
                    )}
                  </tr>
                  {open === s.po_number && (
                    <tr className="wf-po-sku-row">
                      <td colSpan={editable ? 9 : 8}>
                        <table className="wf-grid wf-cost-lines">
                          <thead>
                            <tr>
                              <th>SKU</th>
                              <th>Variant</th>
                              <th>Size</th>
                              <th className="num">Ordered</th>
                              <th className="num">Pending</th>
                              <th className="num">Price</th>
                              <th>EDD</th>
                            </tr>
                          </thead>
                          <tbody>
                            {s.lines.map((l, i) => (
                              <tr key={`${l.sku}-${i}`}>
                                <td className="mono">{l.sku ?? '—'}</td>
                                <td>{l.product_variant ?? '—'}</td>
                                <td>{l.size ?? '—'}</td>
                                <td className="num">{nfmt(l.original_qty)}</td>
                                <td className="num">{nfmt(l.pending_qty)}</td>
                                <td className="num">{l.item_price ?? '—'}</td>
                                <td className="wf-subtle">{l.expected_delivery_date ?? '—'}</td>
                              </tr>
                            ))}
                          </tbody>
                        </table>
                      </td>
                    </tr>
                  )}
                </Fragment>
              ))}
              {!shown.length && (
                <tr>
                  <td colSpan={editable ? 9 : 8} className="wf-empty-cell">
                    No open POs{submissions.length ? ' match your filter.' : ' (loads from the PO pipeline).'}
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}

/** Standard TNA lead-times — documented once, drives the critical-path auto-generate. */
function TnaLeadtimesPanel({ leadtimes }: { leadtimes: TnaLeadtimes }) {
  const [d, setD] = useState({
    pp_sample_days: leadtimes.pp_sample_days?.toString() ?? '',
    gpt_days: leadtimes.gpt_days?.toString() ?? '',
    cutting_days: leadtimes.cutting_days?.toString() ?? '',
    inline_qc_days: leadtimes.inline_qc_days?.toString() ?? '',
    first_delivery_days: leadtimes.first_delivery_days?.toString() ?? '',
    po_closing_days: leadtimes.po_closing_days?.toString() ?? '',
  });
  const [busy, start] = useTransition();
  const [msg, setMsg] = useState<string | null>(null);
  const set = (k: keyof typeof d, v: string) => setD((c) => ({ ...c, [k]: v }));

  function save() {
    const fd = new FormData();
    Object.entries(d).forEach(([k, v]) => fd.set(k, v));
    start(async () => {
      const res = await saveTnaLeadtimes(fd);
      setMsg(res.ok ? 'Saved.' : res.error);
      if (res.ok) reloadWithToast();
    });
  }

  const FIELDS: [keyof typeof d, string][] = [
    ['pp_sample_days', 'PP sample (+days)'],
    ['gpt_days', 'GPT (+days)'],
    ['cutting_days', 'Cutting (+days)'],
    ['inline_qc_days', 'Inline QC (+days)'],
    ['first_delivery_days', 'First delivery (+days)'],
    ['po_closing_days', 'PO closing (+days)'],
  ];

  return (
    <details className="wf-standards-panel">
      <summary>TNA lead-times — documented once, auto-generates the critical path</summary>
      {msg && <Notice tone="ok">{msg}</Notice>}
      <div className="wf-form-grid">
        {FIELDS.map(([k, label]) => (
          <Field key={k} label={label}>
            <input type="number" min={0} value={d[k]} onChange={(e) => set(k, e.target.value)} />
          </Field>
        ))}
        <button type="button" className="wf-btn wf-btn-primary wf-btn-sm" onClick={save} disabled={busy}>
          <Save size={13} /> {busy ? 'Saving…' : 'Save lead-times'}
        </button>
      </div>
    </details>
  );
}
