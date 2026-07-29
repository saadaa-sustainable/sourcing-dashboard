'use client';

import { useEffect, useMemo, useState, useTransition } from 'react';
import {
  ChevronDown,
  ChevronRight,
  ClipboardList,
  Eye,
  Plus,
  Save,
  Send,
  Trash2,
} from 'lucide-react';
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

// A fresh, zeroed row for a product code. Status and Woven/Knit are display-only
// and come from sd_product_master (read-only), so they are not seeded here.
function blankDraft(code: string, key: string): Draft {
  return {
    key,
    product_code: code,
    product_status: '',
    fabric_type: '',
    pending_quantity: '',
    job_work_qty: '0',
    fob_qty: '0',
    efob_qty: '0',
    standard_value: '',
  };
}

export function BuyingPlanClient({
  planMonth,
  plan,
  lines,
  productCodes,
  productMaster,
  standardCosts,
  actuals,
  role,
}: {
  planMonth: string;
  plan: BuyingPlan | null;
  lines: BuyingPlanLine[];
  productCodes: string[];
  productMaster: Record<string, { status: string | null; fabric_type: string | null }>;
  standardCosts: Record<string, { job: number; fob: number; efob: number }>;
  actuals: Record<string, { qty: number; value: number }>;
  role: SdRole;
}) {
  const status: SdStatus = plan?.status ?? 'draft';
  const editable = canEdit(role, status);

  // Spec: every active product is listed; you zero out what you won't make.
  // A saved plan shows its stored lines; a fresh editable plan pre-lists all
  // active product codes (zeroed). A read-only viewer of an empty plan sees none.
  const [rows, setRows] = useState<Draft[]>(() =>
    lines.length
      ? lines.map(toDraft)
      : editable
        ? productCodes.map((code, index) => blankDraft(code, `seed-${code}-${index}`))
        : [],
  );
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pending, start] = useTransition();

  // Input module (fill the plan) vs View module (running read-only view). Default
  // to View — "एक view चलता रहे"; supply chain switches to Input to fill it.
  const [mode, setMode] = useState<'view' | 'input'>('view');
  const [overdueOnly, setOverdueOnly] = useState(false);
  const [collapsed, setCollapsed] = useState<Record<string, boolean>>({});

  // Overdue = buying still outstanding more than a week into the plan month.
  // Evaluated after mount so server/client render match.
  const [now, setNow] = useState<number | null>(null);
  useEffect(() => setNow(Date.now()), []);
  const overdueThreshold = Date.parse(`${planMonth}T00:00:00Z`) + 7 * 86_400_000;

  const used = useMemo(
    () => new Set(rows.map((row) => row.product_code)),
    [rows],
  );
  const available = productCodes.filter((code) => !used.has(code));

  const view = rows.map((row) => {
    const jobQty = num(row.job_work_qty);
    const fobQty = num(row.fob_qty);
    const efobQty = num(row.efob_qty);
    const totalQty = jobQty + fobQty + efobQty;
    const cost = standardCosts[row.product_code];
    // Per-PO-type: each quantity multiplies by its own approved standard cost.
    const valueToBeBought = cost
      ? jobQty * cost.job + fobQty * cost.fob + efobQty * cost.efob
      : 0;
    const actual = actuals[row.product_code] ?? { qty: 0, value: 0 };
    const remaining = Math.max(0, totalQty - actual.qty);
    return {
      row,
      totalQty,
      cost,
      // A planned quantity with no approved cost can't be valued — flag it.
      missingCost: totalQty > 0 && !cost,
      valueToBeBought,
      actualQty: actual.qty,
      actualValue: actual.value,
      remaining,
      pctComplete:
        totalQty > 0 ? Math.min(100, Math.round((actual.qty / totalQty) * 100)) : 0,
      isOverdue: remaining > 0 && now != null && now > overdueThreshold,
      fabricType: productMaster[row.product_code]?.fabric_type || 'Unspecified',
      productStatus: productMaster[row.product_code]?.status || '—',
      // Red, but never blocking. Mahesh: show it, don't refuse it.
      overPlan: totalQty > 0 && actual.qty > totalQty,
    };
  });

  type ViewItem = (typeof view)[number];

  // View module works over products that actually have a planned quantity.
  const planned = view.filter((v) => v.totalQty > 0);
  const overdueCount = planned.filter((v) => v.isOverdue).length;
  const viewRows = overdueOnly ? planned.filter((v) => v.isOverdue) : planned;
  const groups: [string, ViewItem[]][] = (() => {
    const m = new Map<string, ViewItem[]>();
    for (const item of viewRows) {
      const list = m.get(item.fabricType) ?? [];
      list.push(item);
      m.set(item.fabricType, list);
    }
    return [...m.entries()].sort((a, b) => a[0].localeCompare(b[0]));
  })();
  const plannedTotals = planned.reduce(
    (acc, item) => ({
      qty: acc.qty + item.totalQty,
      value: acc.value + item.valueToBeBought,
      actualQty: acc.actualQty + item.actualQty,
      actualValue: acc.actualValue + item.actualValue,
    }),
    { qty: 0, value: 0, actualQty: 0, actualValue: 0 },
  );
  const pctBought =
    plannedTotals.qty > 0
      ? Math.min(100, Math.round((plannedTotals.actualQty / plannedTotals.qty) * 100))
      : 0;

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
      blankDraft(code, `new-${code}-${Date.now()}`),
    ]);
  }

  function addAll() {
    setRows((current) => [
      ...current,
      ...available.map((code, index) => blankDraft(code, `bulk-${code}-${index}`)),
    ]);
  }

  function save() {
    setError(null);
    setMessage(null);
    // Status + woven/knit are master-owned; store the master value as the
    // planning-time snapshot rather than anything the user typed.
    const snapshot = rows.map((row) => ({
      ...row,
      product_status: productMaster[row.product_code]?.status ?? '',
      fabric_type: productMaster[row.product_code]?.fabric_type ?? '',
    }));
    const payload = new FormData();
    payload.set('plan_month', planMonth);
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
          <Field label="Month">
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
          <div className="segment wf-segment">
            <button
              type="button"
              className={mode === 'view' ? 'active' : ''}
              onClick={() => setMode('view')}
            >
              <Eye size={14} /> View
            </button>
            <button
              type="button"
              className={mode === 'input' ? 'active' : ''}
              onClick={() => setMode('input')}
            >
              <ClipboardList size={14} /> Input
            </button>
          </div>
        </div>

        {editable && mode === 'input' && (
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

      {mode === 'view' && (
        <PlanView
          groups={groups}
          totals={plannedTotals}
          pctBought={pctBought}
          overdueCount={overdueCount}
          overdueOnly={overdueOnly}
          setOverdueOnly={setOverdueOnly}
          collapsed={collapsed}
          setCollapsed={setCollapsed}
          plannedCount={planned.length}
        />
      )}

      {mode === 'input' && (
      <>
      <div className="table-panel wf-grid-panel">
        <div className="table-scroll">
          <table className="wide-table wf-grid">
            <thead>
              <tr>
                <th>Product code</th>
                <th>Product status</th>
                <th>Woven / Knitted</th>
                <th className="num input-col">Job work qty</th>
                <th className="num input-col">FOB qty</th>
                <th className="num input-col">E-FOB qty</th>
                <th className="num">Total quantity</th>
                <th className="num">Standard cost (J / F / E)</th>
                <th className="num">Value to be bought</th>
                <th className="num">Actual issued qty / value</th>
                {editable && <th aria-label="Remove" />}
              </tr>
            </thead>
            <tbody>
              {view.map(({ row, totalQty, cost, missingCost, valueToBeBought, actualQty, actualValue, overPlan }) => (
                <tr key={row.key} className={overPlan ? 'wf-row-over' : ''}>
                  <td className="mono">{row.product_code}</td>
                  <td>{productMaster[row.product_code]?.status || '—'}</td>
                  <td>{productMaster[row.product_code]?.fabric_type || '—'}</td>
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
                  <td className="num">
                    {cost
                      ? `${fmt.format(cost.job)} / ${fmt.format(cost.fob)} / ${fmt.format(cost.efob)}`
                      : '—'}
                  </td>
                  <td className="num">
                    {missingCost ? (
                      <span className="wf-over-tag">no approved cost</span>
                    ) : (
                      money.format(valueToBeBought)
                    )}
                  </td>
                  <td className="num">
                    {fmt.format(actualQty)} / {money.format(actualValue)}
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
                  <td colSpan={11} className="wf-empty-cell">
                    No product codes added yet. Discontinued variants are excluded
                    automatically.
                  </td>
                </tr>
              )}
            </tbody>
            {view.length > 0 && (
              <tfoot>
                <tr>
                  <td colSpan={6}>Total</td>
                  <td className="num strong">{fmt.format(totals.qty)}</td>
                  <td />
                  <td className="num strong">{money.format(totals.value)}</td>
                  <td className="num">
                    {fmt.format(totals.actualQty)} / {money.format(totals.actualValue)}
                  </td>
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
      )}
    </>
  );
}

type ViewItemFull = {
  row: Draft;
  totalQty: number;
  cost?: { job: number; fob: number; efob: number };
  missingCost: boolean;
  valueToBeBought: number;
  actualQty: number;
  actualValue: number;
  remaining: number;
  pctComplete: number;
  isOverdue: boolean;
  fabricType: string;
  productStatus: string;
  overPlan: boolean;
};

function Progress({ pct, overdue = false }: { pct: number; overdue?: boolean }) {
  return (
    <div className="wf-progress">
      <div
        className={overdue ? 'wf-progress-fill wf-progress-over' : 'wf-progress-fill'}
        style={{ width: `${Math.max(0, Math.min(100, pct))}%` }}
      />
    </div>
  );
}

function PlanView({
  groups,
  totals,
  pctBought,
  overdueCount,
  overdueOnly,
  setOverdueOnly,
  collapsed,
  setCollapsed,
  plannedCount,
}: {
  groups: [string, ViewItemFull[]][];
  totals: { qty: number; value: number; actualQty: number; actualValue: number };
  pctBought: number;
  overdueCount: number;
  overdueOnly: boolean;
  setOverdueOnly: (v: boolean) => void;
  collapsed: Record<string, boolean>;
  setCollapsed: (updater: (c: Record<string, boolean>) => Record<string, boolean>) => void;
  plannedCount: number;
}) {
  if (!plannedCount) {
    return (
      <div className="empty-state">
        <p>Nothing planned yet — switch to Input to fill this month’s buying plan.</p>
      </div>
    );
  }

  return (
    <>
      <div className="metric-grid wf-metric-grid">
        <div className="metric-card">
          <span className="metric-label">Total buying qty</span>
          <strong>{fmt.format(totals.qty)}</strong>
        </div>
        <div className="metric-card">
          <span className="metric-label">Total value to buy</span>
          <strong>{money.format(totals.value)}</strong>
        </div>
        <div className="metric-card tone-teal">
          <span className="metric-label">Issued (actual)</span>
          <strong>{fmt.format(totals.actualQty)}</strong>
          <small>{money.format(totals.actualValue)}</small>
        </div>
        <div className="metric-card">
          <span className="metric-label">% bought</span>
          <strong>{pctBought}%</strong>
          <Progress pct={pctBought} />
        </div>
        <div className={overdueCount ? 'metric-card tone-orange' : 'metric-card'}>
          <span className="metric-label">Overdue</span>
          <strong>{overdueCount}</strong>
        </div>
      </div>

      <div className="wf-toolbar">
        <div className="segment wf-segment">
          <button
            type="button"
            className={!overdueOnly ? 'active' : ''}
            onClick={() => setOverdueOnly(false)}
          >
            All
          </button>
          <button
            type="button"
            className={overdueOnly ? 'active' : ''}
            onClick={() => setOverdueOnly(true)}
          >
            Overdue only ({overdueCount})
          </button>
        </div>
        <div className="wf-toolbar-right">
          <button
            type="button"
            className="wf-btn wf-btn-ghost wf-btn-sm"
            onClick={() =>
              setCollapsed(() => Object.fromEntries(groups.map(([f]) => [f, true])))
            }
          >
            Collapse all
          </button>
          <button
            type="button"
            className="wf-btn wf-btn-ghost wf-btn-sm"
            onClick={() => setCollapsed(() => ({}))}
          >
            Expand all
          </button>
        </div>
      </div>

      <div className="wf-plan-groups">
        {groups.map(([fabric, items]) => {
          const gt = items.reduce(
            (a, it) => ({
              qty: a.qty + it.totalQty,
              value: a.value + it.valueToBeBought,
              actualQty: a.actualQty + it.actualQty,
            }),
            { qty: 0, value: 0, actualQty: 0 },
          );
          const gPct = gt.qty > 0 ? Math.round((gt.actualQty / gt.qty) * 100) : 0;
          const isCollapsed = collapsed[fabric];
          return (
            <div className="wf-plan-group" key={fabric}>
              <button
                type="button"
                className="wf-plan-group-head"
                onClick={() =>
                  setCollapsed((c) => ({ ...c, [fabric]: !c[fabric] }))
                }
              >
                {isCollapsed ? <ChevronRight size={16} /> : <ChevronDown size={16} />}
                <span className="wf-plan-group-name">{fabric}</span>
                <span className="wf-subtle">{items.length} products</span>
                <span className="wf-plan-group-stat">{fmt.format(gt.qty)} pcs</span>
                <span className="wf-plan-group-stat">{money.format(gt.value)}</span>
                <span className="wf-plan-group-bar">
                  <Progress pct={gPct} />
                </span>
              </button>
              {!isCollapsed && (
                <div className="wf-plan-group-body">
                  {items.map((it) => (
                    <div
                      className={it.isOverdue ? 'wf-plan-line wf-plan-line-over' : 'wf-plan-line'}
                      key={it.row.key}
                    >
                      <span className="mono wf-plan-code">{it.row.product_code}</span>
                      <span className="wf-subtle">{it.productStatus}</span>
                      <span className="num">{fmt.format(it.totalQty)} pcs</span>
                      <span className="num">
                        {it.missingCost ? (
                          <span className="wf-over-tag">no approved cost</span>
                        ) : (
                          money.format(it.valueToBeBought)
                        )}
                      </span>
                      <span className="wf-plan-line-bar">
                        <Progress pct={it.pctComplete} overdue={it.isOverdue} />
                      </span>
                      <span className="num wf-subtle">{it.pctComplete}%</span>
                      <span className="num wf-subtle">
                        {it.remaining > 0 ? `${fmt.format(it.remaining)} left` : 'done'}
                      </span>
                      {it.isOverdue && <span className="wf-overdue-tag">overdue</span>}
                    </div>
                  ))}
                </div>
              )}
            </div>
          );
        })}
      </div>
    </>
  );
}
