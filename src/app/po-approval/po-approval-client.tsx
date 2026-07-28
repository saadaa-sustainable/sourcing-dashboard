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
import type { PoApproval, PoCycleTime, PoType, SdRole } from '@/lib/forms/types';

const PO_TYPES: PoType[] = ['FG', 'Material', 'NPD'];

const BLANK = {
  po_ref: '',
  po_type: 'FG' as PoType,
  product_code: '',
  vendor_code: '',
  quantity: '',
  cost_sheet_link: '',
  tna_link: '',
  tna_pp_date: '',
  tna_gpt_date: '',
  tna_cutting_date: '',
  tna_inline_date: '',
  closing_date: '',
};

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

  const buildPayload = (id?: number) => {
    const p = new FormData();
    if (id) p.set('id', String(id));
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

  return (
    <>
      <Notice tone="info">
        FG / Material up to 5,000 pcs are signed off by the team; anything larger,
        and every NPD, needs admin approval. After approval, issue the PO with its
        EasyCom number to tie it back to real data.
      </Notice>

      {message && <Notice tone="ok">{message}</Notice>}
      {error && <Notice tone="error">{error}</Notice>}

      {editable && (
        <div className="panel wf-form-panel">
          <div className="panel-title">
            <h3>Raise a PO for approval</h3>
          </div>
          <div className="wf-form-grid">
            <Field label="PO ref" hint="Auto-numbering is phase 2">
              <input
                value={form.po_ref}
                placeholder="e.g. PO-2026-07-014"
                onChange={(e) => set('po_ref', e.target.value)}
              />
            </Field>
            <Field label="Type">
              <select
                value={form.po_type}
                onChange={(e) => set('po_type', e.target.value)}
              >
                {PO_TYPES.map((t) => (
                  <option key={t} value={t}>
                    {t}
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
            <Field label="Quantity" hint="Drives approval routing">
              <input
                type="number"
                min={0}
                value={form.quantity}
                onChange={(e) => set('quantity', e.target.value)}
              />
            </Field>
            <Field label="Cost sheet link">
              <input
                value={form.cost_sheet_link}
                placeholder="https://…"
                onChange={(e) => set('cost_sheet_link', e.target.value)}
              />
            </Field>
            <Field label="TNA link">
              <input
                value={form.tna_link}
                placeholder="https://…"
                onChange={(e) => set('tna_link', e.target.value)}
              />
            </Field>
            <Field label="TNA — PP sample">
              <input
                type="date"
                value={form.tna_pp_date}
                onChange={(e) => set('tna_pp_date', e.target.value)}
              />
            </Field>
            <Field label="TNA — GPT">
              <input
                type="date"
                value={form.tna_gpt_date}
                onChange={(e) => set('tna_gpt_date', e.target.value)}
              />
            </Field>
            <Field label="TNA — Cutting">
              <input
                type="date"
                value={form.tna_cutting_date}
                onChange={(e) => set('tna_cutting_date', e.target.value)}
              />
            </Field>
            <Field label="TNA — Inline">
              <input
                type="date"
                value={form.tna_inline_date}
                onChange={(e) => set('tna_inline_date', e.target.value)}
              />
            </Field>
            <Field label="Closing date">
              <input
                type="date"
                value={form.closing_date}
                onChange={(e) => set('closing_date', e.target.value)}
              />
            </Field>
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
              disabled={pending || !form.product_code || !Number(form.quantity)}
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
                <th>Type</th>
                <th>Product</th>
                <th>Vendor (live load)</th>
                <th>Qty · Colours</th>
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
    p.set('easycom_po_number', easycom);
    start(async () => {
      const res = await issuePoApproval(p);
      if (res.ok) window.location.reload();
      else setError(res.error);
    });
  }

  return (
    <tr>
      <td className="mono">{po.po_ref ?? `#${po.id}`}</td>
      <td>{po.po_type}</td>
      <td className="mono">{po.product_code ?? '—'}</td>
      <td>
        {po.vendor_code ?? '—'}
        {po.vendor_code && (
          <small className="wf-subtle">
            {liveLoad == null
              ? 'no open POs'
              : `${liveLoad.toLocaleString('en-IN')} pcs in process`}
          </small>
        )}
      </td>
      <td>
        {Number(po.quantity).toLocaleString('en-IN')}
        {po.number_of_colours ? ` · ${po.number_of_colours}c` : ''}
      </td>
      <td>
        <StatusBadge status={po.status} />
        {po.status === 'rejected' && po.rejection_notes && (
          <small className="wf-subtle">{po.rejection_notes}</small>
        )}
        {po.easycom_po_number && (
          <small className="wf-subtle">EasyCom {po.easycom_po_number}</small>
        )}
      </td>
      <td className="wf-subtle">
        {cycle?.days_total != null
          ? `${cycle.days_total} total`
          : cycle?.days_submit_to_approve != null
            ? `${cycle.days_submit_to_approve} to approve`
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
              entityLabel={`PO ${po.po_ref ?? `#${po.id}`} · ${po.po_type}`}
              onDone={(res) => {
                if (res.ok) window.location.reload();
              }}
            />
          ) : (
            <span className="wf-subtle">Awaiting approval</span>
          ))}
        {po.status === 'approved' &&
          !po.easycom_po_number &&
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
        {po.status === 'approved' && po.easycom_po_number && (
          <span className="wf-subtle">Issued</span>
        )}
      </td>
    </tr>
  );
}
