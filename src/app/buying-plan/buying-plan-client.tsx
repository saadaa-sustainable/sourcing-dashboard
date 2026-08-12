'use client';

import { useEffect, useMemo, useRef, useState, useTransition } from 'react';
import {
  ChevronDown,
  ChevronRight,
  ClipboardList,
  Download,
  Eye,
  Plus,
  Save,
  Send,
  Trash2,
  Upload,
} from 'lucide-react';
import { saveBuyingPlan, submitBuyingPlan } from '@/lib/forms/actions';
import { csvObjects, downloadCsv } from '@/lib/csv';
import { PlanPivot } from '@/components/forms/plan-pivot';
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
  line_status: string; // read-only snapshot; drives the Pending/Approved pivot split
  remark: string; // optional note, shared import contract with the material track
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
    line_status: line.line_status ?? '',
    remark: line.remark ?? '',
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
    line_status: '',
    remark: '',
  };
}

export function BuyingPlanClient({
  planMonth,
  plan,
  lines,
  productCodes,
  productMaster,
  standardCosts,
  pendingByCode,
  actuals,
  role,
}: {
  planMonth: string;
  plan: BuyingPlan | null;
  lines: BuyingPlanLine[];
  productCodes: string[];
  productMaster: Record<string, { status: string | null; fabric_type: string | null }>;
  standardCosts: Record<string, { job: number; fob: number; efob: number }>;
  pendingByCode: Record<string, number>;
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
  const fileRef = useRef<HTMLInputElement>(null);

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
  const pivotRows = planned.map((v) => ({
    fabricType: v.fabricType,
    qty: v.totalQty,
    value: v.valueToBeBought,
    approved: v.row.line_status === 'approved',
  }));
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

  // Bulk-load a month's plan from a `product_code,po_type,qty` CSV (long form:
  // one row per PO type). Each product code is validated against the active list;
  // po_type is pivoted into the Job/FOB/E-FOB columns. Invalid or zero rows are
  // skipped with a summary — they never block the rest of the import.
  const codeSet = useMemo(() => new Set(productCodes), [productCodes]);

  function poTypeOf(value: string): 'job_work_qty' | 'fob_qty' | 'efob_qty' | null {
    const n = value.trim().toLowerCase().replace(/[^a-z]/g, '');
    if (n === 'job' || n === 'jobwork') return 'job_work_qty';
    if (n === 'fob') return 'fob_qty';
    if (n === 'efob') return 'efob_qty';
    return null;
  }

  function downloadTemplate() {
    const examples = productCodes.slice(0, 2).map((code) => [code, 'fob', '100', '']);
    downloadCsv(
      'buying-plan-template.csv',
      ['product_code', 'po_type', 'qty', 'remark'],
      examples,
    );
  }

  async function onCsvFile(file: File) {
    setError(null);
    setMessage(null);
    let objects: Record<string, string>[];
    try {
      objects = csvObjects(await file.text());
    } catch {
      setError('Could not read that file as CSV.');
      return;
    }
    const acc = new Map<string, { job_work_qty: number; fob_qty: number; efob_qty: number; remark: string }>();
    const skipped: string[] = [];
    objects.forEach((r, i) => {
      const line = i + 2; // +1 header, +1 to 1-index
      const code = String(r.product_code ?? '').trim();
      const field = poTypeOf(String(r.po_type ?? ''));
      const qty = Number(r.qty);
      if (!code) return skipped.push(`row ${line}: missing product code`);
      if (!codeSet.has(code)) return skipped.push(`row ${line}: unknown code "${code}"`);
      if (!field) return skipped.push(`row ${line}: unknown po_type "${r.po_type ?? ''}"`);
      if (!Number.isFinite(qty) || qty <= 0) return skipped.push(`row ${line}: non-positive qty`);
      const cur = acc.get(code) ?? { job_work_qty: 0, fob_qty: 0, efob_qty: 0, remark: '' };
      cur[field] += qty;
      if (r.remark) cur.remark = String(r.remark);
      acc.set(code, cur);
    });

    if (!acc.size) {
      setError(
        `No valid rows imported.${skipped.length ? ` ${skipped.slice(0, 5).join('; ')}` : ' Expected headers: product_code, po_type, qty.'}`,
      );
      return;
    }

    setRows((current) => {
      const map = new Map(current.map((row) => [row.product_code, row] as const));
      let seq = 0;
      for (const [code, q] of acc) {
        const base = map.get(code) ?? blankDraft(code, `csv-${code}-${seq++}`);
        map.set(code, {
          ...base,
          job_work_qty: String(q.job_work_qty),
          fob_qty: String(q.fob_qty),
          efob_qty: String(q.efob_qty),
          remark: q.remark || base.remark,
        });
      }
      return [...map.values()];
    });
    setMessage(
      `Imported ${acc.size} product(s).` +
        (skipped.length
          ? ` Skipped ${skipped.length} row(s): ${skipped.slice(0, 6).join('; ')}${skipped.length > 6 ? '…' : ''}`
          : ''),
    );
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
            <input
              ref={fileRef}
              type="file"
              accept=".csv,text/csv"
              hidden
              onChange={(event) => {
                const file = event.target.files?.[0];
                if (file) void onCsvFile(file);
                event.target.value = '';
              }}
            />
            <button type="button" className="wf-btn wf-btn-ghost" onClick={downloadTemplate}>
              <Download size={15} /> Template
            </button>
            <button
              type="button"
              className="wf-btn wf-btn-ghost"
              onClick={() => fileRef.current?.click()}
              title="Import a product_code, po_type, qty CSV"
            >
              <Upload size={15} /> Import CSV
            </button>
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
        <>
        <PlanPivot rows={pivotRows} title="Woven vs Knitted — pending & approved" />
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
        </>
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
                <th className="num wf-cell-calc">Pending qty</th>
                <th className="num input-col wf-cell-input">Job work qty</th>
                <th className="num input-col wf-cell-input">FOB qty</th>
                <th className="num input-col wf-cell-input">E-FOB qty</th>
                <th className="num wf-cell-calc">Total quantity</th>
                <th className="num wf-cell-calc">
                  Standard cost<small className="wf-subtle">Job · FOB · E-FOB</small>
                </th>
                <th className="num wf-cell-calc">Value to be bought</th>
                <th className="num wf-cell-calc">Actual issued quantity</th>
                <th className="num wf-cell-calc">Actual issued value</th>
                <th className="input-col wf-cell-input">Remark</th>
                {editable && <th aria-label="Remove" />}
              </tr>
            </thead>
            <tbody>
              {view.map(({ row, totalQty, cost, missingCost, valueToBeBought, actualQty, actualValue, overPlan }) => (
                <tr key={row.key} className={overPlan ? 'wf-row-over' : ''}>
                  <td className="mono">{row.product_code}</td>
                  <td>{productMaster[row.product_code]?.status || '—'}</td>
                  <td>{productMaster[row.product_code]?.fabric_type || '—'}</td>
                  <td className="num wf-cell-calc">
                    {pendingByCode[row.product_code]
                      ? fmt.format(pendingByCode[row.product_code])
                      : '—'}
                  </td>
                  {(['job_work_qty', 'fob_qty', 'efob_qty'] as const).map((field) => (
                    <td key={field} className="num input-col wf-cell-input">
                      <input
                        type="number"
                        min={0}
                        value={row[field]}
                        disabled={!editable}
                        onChange={(event) => patch(row.key, field, event.target.value)}
                      />
                    </td>
                  ))}
                  <td className="num strong wf-cell-calc">{fmt.format(totalQty)}</td>
                  <td className="num wf-cell-calc">
                    {cost ? (
                      <div className="wf-cost-triple">
                        <span><b>Job</b> {fmt.format(cost.job)}</span>
                        <span><b>FOB</b> {fmt.format(cost.fob)}</span>
                        <span><b>E-FOB</b> {fmt.format(cost.efob)}</span>
                      </div>
                    ) : (
                      '—'
                    )}
                  </td>
                  <td className="num wf-cell-calc">
                    {missingCost ? (
                      <span className="wf-over-tag">no approved cost</span>
                    ) : (
                      money.format(valueToBeBought)
                    )}
                  </td>
                  <td className="num wf-cell-calc">
                    {fmt.format(actualQty)}
                    {overPlan && <span className="wf-over-tag">over plan</span>}
                  </td>
                  <td className="num wf-cell-calc">{money.format(actualValue)}</td>
                  <td className="input-col">
                    <input
                      value={row.remark}
                      disabled={!editable}
                      placeholder="optional"
                      onChange={(event) => patch(row.key, 'remark', event.target.value)}
                    />
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
                  <td colSpan={editable ? 14 : 13} className="wf-empty-cell">
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
                  <td className="num strong">{fmt.format(totals.actualQty)}</td>
                  <td className="num strong">{money.format(totals.actualValue)}</td>
                  <td />
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
