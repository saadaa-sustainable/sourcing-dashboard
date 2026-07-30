'use client';

import { useState, useTransition } from 'react';
import { Plus, Save, Send, Trash2 } from 'lucide-react';
import { saveBuyingPlan, submitBuyingPlan } from '@/lib/forms/actions';
import { canApprove, canEdit, canSubmit } from '@/lib/forms/approval';
import { Notice, StatusBadge } from '@/components/forms/form-layout';
import { ApprovalBar } from '@/components/forms/approval-bar';
import type { BuyingPlan, BuyingPlanLine, SdRole, SdStatus } from '@/lib/forms/types';

const money = new Intl.NumberFormat('en-IN', {
  style: 'currency',
  currency: 'INR',
  maximumFractionDigits: 0,
});
const num = (v: string) => Number(v) || 0;
const UOMS = ['metres', 'kg', 'pcs', 'rolls', 'sets'];

type Row = { key: string; material_code: string; quantity: string; uom: string; rate: string };

export function MaterialPlanClient({
  planMonth,
  plan,
  lines,
  materialCodes,
  role,
}: {
  planMonth: string;
  plan: BuyingPlan | null;
  lines: BuyingPlanLine[];
  materialCodes: { material_code: string; fabric_name: string | null }[];
  role: SdRole;
}) {
  const status: SdStatus = plan?.status ?? 'draft';
  const editable = canEdit(role, status);
  const [rows, setRows] = useState<Row[]>(() =>
    lines.map((l) => ({
      key: `line-${l.id}`,
      material_code: l.product_code,
      quantity: l.fob_qty?.toString() ?? '',
      uom: l.uom ?? 'metres',
      rate: l.standard_value?.toString() ?? '',
    })),
  );
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pending, start] = useTransition();

  const view = rows.map((r) => ({ row: r, value: num(r.quantity) * num(r.rate) }));
  const total = view.reduce((s, v) => s + v.value, 0);

  const set = (key: string, field: keyof Row, value: string) =>
    setRows((cur) => cur.map((r) => (r.key === key ? { ...r, [field]: value } : r)));

  function addRow() {
    setRows((cur) => [
      ...cur,
      { key: `new-${Date.now()}`, material_code: '', quantity: '', uom: 'metres', rate: '' },
    ]);
  }

  function save() {
    setError(null);
    setMessage(null);
    const snapshot = rows
      .filter((r) => r.material_code.trim())
      .map((r) => ({
        product_code: r.material_code.trim(),
        fob_qty: r.quantity,
        standard_value: r.rate,
        uom: r.uom,
      }));
    const payload = new FormData();
    payload.set('plan_month', planMonth);
    payload.set('plan_type', 'material');
    payload.set('lines', JSON.stringify(snapshot));
    start(async () => {
      const result = await saveBuyingPlan(payload);
      if (result.ok) setMessage(result.message ?? 'Saved.');
      else setError(result.error);
    });
  }

  function submit() {
    if (!plan?.id) {
      setError('Save the plan before submitting it.');
      return;
    }
    setError(null);
    setMessage(null);
    const payload = new FormData();
    payload.set('plan_id', String(plan.id));
    start(async () => {
      const result = await submitBuyingPlan(payload);
      if (result.ok) setMessage(result.message ?? 'Submitted.');
      else setError(result.error);
    });
  }

  return (
    <>
      <div className="wf-toolbar">
        <div className="wf-toolbar-left">
          <StatusBadge status={status} />
        </div>
        {editable && (
          <div className="wf-toolbar-right">
            <button type="button" className="wf-btn wf-btn-ghost" onClick={addRow}>
              <Plus size={15} /> Add fabric / material
            </button>
          </div>
        )}
      </div>

      <Notice tone="info">
        Fabric / raw-material buying for the month — the same Save → Submit → Approve
        flow as Finished Goods, on its own track. Value = quantity × rate.
      </Notice>

      {plan?.rejection_notes && status === 'rejected' && (
        <Notice tone="error">
          <strong>Rejected.</strong> {plan.rejection_notes}
        </Notice>
      )}
      {message && <Notice tone="ok">{message}</Notice>}
      {error && <Notice tone="error">{error}</Notice>}

      <div className="table-panel wf-grid-panel">
        <div className="table-scroll">
          <table className="wide-table wf-grid">
            <thead>
              <tr>
                <th>Fabric / material code</th>
                <th className="num input-col">Quantity</th>
                <th>UOM</th>
                <th className="num input-col">Rate</th>
                <th className="num">Value</th>
                {editable && <th aria-label="Remove" />}
              </tr>
            </thead>
            <tbody>
              {view.map(({ row, value }) => (
                <tr key={row.key}>
                  <td className="input-col">
                    <input
                      list="material-codes"
                      value={row.material_code}
                      placeholder="RM code / fabric"
                      disabled={!editable}
                      onChange={(e) => set(row.key, 'material_code', e.target.value)}
                    />
                  </td>
                  <td className="num input-col">
                    <input
                      type="number"
                      min={0}
                      value={row.quantity}
                      disabled={!editable}
                      onChange={(e) => set(row.key, 'quantity', e.target.value)}
                    />
                  </td>
                  <td>
                    <select
                      value={row.uom}
                      disabled={!editable}
                      onChange={(e) => set(row.key, 'uom', e.target.value)}
                    >
                      {UOMS.map((u) => (
                        <option key={u} value={u}>
                          {u}
                        </option>
                      ))}
                    </select>
                  </td>
                  <td className="num input-col">
                    <input
                      type="number"
                      min={0}
                      value={row.rate}
                      disabled={!editable}
                      onChange={(e) => set(row.key, 'rate', e.target.value)}
                    />
                  </td>
                  <td className="num strong">{money.format(value)}</td>
                  {editable && (
                    <td>
                      <button
                        type="button"
                        className="wf-icon-btn"
                        aria-label={`Remove ${row.material_code}`}
                        onClick={() =>
                          setRows((cur) => cur.filter((r) => r.key !== row.key))
                        }
                      >
                        <Trash2 size={14} />
                      </button>
                    </td>
                  )}
                </tr>
              ))}
              {!view.length && (
                <tr>
                  <td colSpan={editable ? 6 : 5} className="wf-empty-cell">
                    No fabric lines yet — add one above.
                  </td>
                </tr>
              )}
            </tbody>
            {view.length > 0 && (
              <tfoot>
                <tr>
                  <td colSpan={4}>Total</td>
                  <td className="num strong">{money.format(total)}</td>
                  {editable && <td />}
                </tr>
              </tfoot>
            )}
          </table>
          <datalist id="material-codes">
            {materialCodes.map((m) => (
              <option key={m.material_code} value={m.material_code}>
                {m.fabric_name ?? ''}
              </option>
            ))}
          </datalist>
        </div>
      </div>

      <div className="wf-footer-bar">
        <p className="wf-footer-note">
          Fabric buying value for the month, on its own approval track.
        </p>
        <div className="wf-footer-actions">
          {editable && (
            <button
              type="button"
              className="wf-btn wf-btn-ghost"
              onClick={save}
              disabled={pending}
            >
              <Save size={15} /> {pending ? 'Saving…' : 'Save draft'}
            </button>
          )}
          {canSubmit(role, status) && (
            <button
              type="button"
              className="wf-btn wf-btn-primary"
              onClick={submit}
              disabled={pending || !plan?.id}
            >
              <Send size={15} /> Submit for approval
            </button>
          )}
          {canApprove(role, status) && plan && (
            <ApprovalBar
              entityType="buying_plan"
              entityId={String(plan.id)}
              entityLabel={`Material plan ${planMonth.slice(0, 7)}`}
              onDone={(result) => {
                if (result.ok) window.location.reload();
              }}
            />
          )}
        </div>
      </div>
    </>
  );
}
