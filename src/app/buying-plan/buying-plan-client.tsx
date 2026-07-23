'use client';

import { useMemo, useState, useTransition } from 'react';
import { Plus, Save, Send, Trash2 } from 'lucide-react';
import { saveBuyingPlan, submitBuyingPlan } from '@/lib/forms/actions';
import {
  addMonths,
  canApprove,
  canEdit,
  canSubmit,
  isPlanWindowOpen,
  monthLabel,
} from '@/lib/forms/approval';
import { Field, Notice, StatusBadge } from '@/components/forms/form-layout';
import { ApprovalBar } from '@/components/forms/approval-bar';
import type {
  BuyingPlan,
  BuyingPlanLine,
  SdRole,
  SdStatus,
} from '@/lib/forms/types';

type Draft = {
  key: string;
  product_code: string;
  product_status: string;
  fabric_type: string;
  pending_quantity: string;
  job_work_qty: string;
  fob_qty: string;
  efob_qty: string;
  standard_value: string;
};

const money = new Intl.NumberFormat('en-IN', {
  style: 'currency',
  currency: 'INR',
  maximumFractionDigits: 0,
});
const fmt = new Intl.NumberFormat('en-IN', { maximumFractionDigits: 0 });
const num = (value: string) => Number(value) || 0;

function toDraft(line: BuyingPlanLine): Draft {
  return {
    key: `line-${line.id}`,
    product_code: line.product_code,
    product_status: line.product_status ?? '',
    fabric_type: line.fabric_type ?? '',
    pending_quantity: line.pending_quantity?.toString() ?? '',
    job_work_qty: line.job_work_qty?.toString() ?? '0',
    fob_qty: line.fob_qty?.toString() ?? '0',
    efob_qty: line.efob_qty?.toString() ?? '0',
    standard_value: line.standard_value?.toString() ?? '',
  };
}

export function BuyingPlanClient({
  planMonth,
  plan,
  lines,
  productCodes,
  actuals,
  role,
}: {
  planMonth: string;
  plan: BuyingPlan | null;
  lines: BuyingPlanLine[];
  productCodes: string[];
  actuals: Record<string, { qty: number; value: number }>;
  role: SdRole;
}) {
  const status: SdStatus = plan?.status ?? 'draft';
  const editable = canEdit(role, status);

  const [rows, setRows] = useState<Draft[]>(() => lines.map(toDraft));
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pending, start] = useTransition();

  const used = useMemo(
    () => new Set(rows.map((row) => row.product_code)),
    [rows],
  );
  const available = productCodes.filter((code) => !used.has(code));

  const view = rows.map((row) => {
    const totalQty = num(row.job_work_qty) + num(row.fob_qty) + num(row.efob_qty);
    const actual = actuals[row.product_code] ?? { qty: 0, value: 0 };
    return {
      row,
      totalQty,
      valueToBeBought: totalQty * num(row.standard_value),
      actualQty: actual.qty,
      actualValue: actual.value,
      // Red, but never blocking. Mahesh: show it, don't refuse it.
      overPlan: totalQty > 0 && actual.qty > totalQty,
    };
  });

  const totals = view.reduce(
    (acc, item) => ({
      qty: acc.qty + item.totalQty,
      value: acc.value + item.valueToBeBought,
      actualQty: acc.actualQty + item.actualQty,
      actualValue: acc.actualValue + item.actualValue,
    }),
    { qty: 0, value: 0, actualQty: 0, actualValue: 0 },
  );

  function patch(key: string, field: keyof Draft, value: string) {
    setRows((current) =>
      current.map((row) => (row.key === key ? { ...row, [field]: value } : row)),
    );
  }

  function addRow(code: string) {
    if (!code) return;
    setRows((current) => [
      ...current,
      {
        key: `new-${code}-${Date.now()}`,
        product_code: code,
        product_status: '',
        fabric_type: '',
        pending_quantity: '',
        job_work_qty: '0',
        fob_qty: '0',
        efob_qty: '0',
        standard_value: '',
      },
    ]);
  }

  function addAll() {
    setRows((current) => [
      ...current,
      ...available.map((code, index) => ({
        key: `bulk-${code}-${index}`,
        product_code: code,
        product_status: '',
        fabric_type: '',
        pending_quantity: '',
        job_work_qty: '0',
        fob_qty: '0',
        efob_qty: '0',
        standard_value: '',
      })),
    ]);
  }

  function save() {
    setError(null);
    setMessage(null);
    const payload = new FormData();
    payload.set('plan_month', planMonth);
    payload.set('lines', JSON.stringify(rows));
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
          <Field label="Plan month">
            <select
              value={planMonth}
              onChange={(event) => {
                window.location.href = `/buying-plan?month=${event.target.value}`;
              }}
            >
              {[-1, 0, 1, 2].map((delta) => {
                const month = addMonths(planMonth, delta);
                return (
                  <option key={month} value={month}>
                    {monthLabel(month)}
                  </option>
                );
              })}
            </select>
          </Field>
          <StatusBadge status={status} />
        </div>

        {editable && (
          <div className="wf-toolbar-right">
            <select
              className="wf-add-select"
              value=""
              onChange={(event) => addRow(event.target.value)}
              disabled={!available.length}
            >
              <option value="">
                {available.length
                  ? `Add product code (${available.length} left)`
                  : 'All product codes added'}
              </option>
              {available.map((code) => (
                <option key={code} value={code}>
                  {code}
                </option>
              ))}
            </select>
            <button
              type="button"
              className="wf-btn wf-btn-ghost"
              onClick={addAll}
              disabled={!available.length}
            >
              <Plus size={15} /> Add all
            </button>
          </div>
        )}
      </div>

      {!isPlanWindowOpen(planMonth) && (
        <Notice tone="warn">
          The window for {monthLabel(planMonth)} opens seven days before the month
          starts. You can still draft ahead.
        </Notice>
      )}

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
                <th>Product code</th>
                <th>Status</th>
                <th>Woven / Knit</th>
                <th className="num">Pending qty</th>
                <th className="num input-col">Job work</th>
                <th className="num input-col">FOB</th>
                <th className="num input-col">E-FOB</th>
                <th className="num">Total qty</th>
                <th className="num input-col">Std value</th>
                <th className="num">Value to buy</th>
                <th className="num">Actual issued</th>
                {editable && <th aria-label="Remove" />}
              </tr>
            </thead>
            <tbody>
              {view.map(({ row, totalQty, valueToBeBought, actualQty, overPlan }) => (
                <tr key={row.key} className={overPlan ? 'wf-row-over' : ''}>
                  <td className="mono">{row.product_code}</td>
                  <td>{row.product_status || '—'}</td>
                  <td>{row.fabric_type || '—'}</td>
                  <td className="num">
                    {row.pending_quantity === ''
                      ? '—'
                      : fmt.format(num(row.pending_quantity))}
                  </td>
                  {(['job_work_qty', 'fob_qty', 'efob_qty'] as const).map((field) => (
                    <td key={field} className="num input-col">
                      <input
                        type="number"
                        min={0}
                        value={row[field]}
                        disabled={!editable}
                        onChange={(event) => patch(row.key, field, event.target.value)}
                      />
                    </td>
                  ))}
                  <td className="num strong">{fmt.format(totalQty)}</td>
                  <td className="num input-col">
                    <input
                      type="number"
                      min={0}
                      placeholder="—"
                      value={row.standard_value}
                      disabled={!editable}
                      onChange={(event) =>
                        patch(row.key, 'standard_value', event.target.value)
                      }
                    />
                  </td>
                  <td className="num">{money.format(valueToBeBought)}</td>
                  <td className="num">
                    {fmt.format(actualQty)}
                    {overPlan && <span className="wf-over-tag">over plan</span>}
                  </td>
                  {editable && (
                    <td>
                      <button
                        type="button"
                        className="wf-icon-btn"
                        aria-label={`Remove ${row.product_code}`}
                        onClick={() =>
                          setRows((current) =>
                            current.filter((item) => item.key !== row.key),
                          )
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
                  <td colSpan={12} className="wf-empty-cell">
                    No product codes added yet. Discontinued variants are excluded
                    automatically.
                  </td>
                </tr>
              )}
            </tbody>
            {view.length > 0 && (
              <tfoot>
                <tr>
                  <td colSpan={7}>Total</td>
                  <td className="num strong">{fmt.format(totals.qty)}</td>
                  <td />
                  <td className="num strong">{money.format(totals.value)}</td>
                  <td className="num">{fmt.format(totals.actualQty)}</td>
                  {editable && <td />}
                </tr>
              </tfoot>
            )}
          </table>
        </div>
      </div>

      <div className="wf-footer-bar">
        <p className="wf-footer-note">
          Allocation may exceed pending quantity — FOB orders run ahead of demand
          because the vendor holds the stock.
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
              entityLabel={`Buying plan ${planMonth.slice(0, 7)}`}
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
