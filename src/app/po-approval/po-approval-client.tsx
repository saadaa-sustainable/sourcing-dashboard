'use client';

import { useMemo, useState, useTransition } from 'react';
import { FileCheck, Save, Send } from 'lucide-react';
import {
  issuePoApproval,
  savePoApproval,
  submitPoApproval,
} from '@/lib/forms/actions';
import { canApprove, canEdit, canSubmit } from '@/lib/forms/approval';
import { Field, Notice, StatusBadge } from '@/components/forms/form-layout';
import { ApprovalBar } from '@/components/forms/approval-bar';
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
            <Field label="PO reference number" hint="Auto-numbering is phase 2">
              <input
                value={form.po_ref_num}
                placeholder="e.g. PO-2026-07-014"
                onChange={(e) => set('po_ref_num', e.target.value)}
              />
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
  const [easycom, setEasycom] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [pending, start] = useTransition();

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

  function issue() {
    setError(null);
    const p = new FormData();
    p.set('id', String(po.id));
    p.set('easycom_po_no', easycom);
    start(async () => {
      const res = await issuePoApproval(p);
      if (res.ok) window.location.reload();
      else setError(res.error);
    });
  }

  return (
    <tr>
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
          (canApprove(role, po.status) ? (
            <ApprovalBar
              entityType="po_approval"
              entityId={String(po.id)}
              entityLabel={`PO ${po.po_ref_num ?? `#${po.id}`} · ${catLabel(po.category)}`}
              onDone={(res) => {
                if (res.ok) window.location.reload();
              }}
            />
          ) : (
            <span className="wf-subtle">Awaiting approval</span>
          ))}
        {po.status === 'approved' &&
          !po.easycom_po_no &&
          canEdit(role, 'draft') && (
            <div className="wf-issue-row">
              <input
                value={easycom}
                placeholder="EasyCom PO #"
                onChange={(e) => setEasycom(e.target.value)}
              />
              <button
                type="button"
                className="wf-btn wf-btn-primary wf-btn-sm"
                onClick={issue}
                disabled={pending || !easycom.trim()}
              >
                <FileCheck size={14} /> Issue
              </button>
            </div>
          )}
        {po.status === 'approved' && po.easycom_po_no && (
          <span className="wf-subtle">Issued</span>
        )}
      </td>
    </tr>
  );
}
