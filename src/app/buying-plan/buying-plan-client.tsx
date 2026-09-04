'use client';

import { useMemo, useRef, useState, useTransition } from 'react';
import { reloadWithToast } from '@/lib/toast';
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
import { saveAnalyticsRule, saveBuyingPlan, submitBuyingPlan } from '@/lib/forms/actions';
import { csvObjects, downloadCsv } from '@/lib/csv';
import { FilterTable, type Column } from '@/components/filter-table';
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
import { ProductPicker } from '@/components/forms/product-picker';
import type {
  BuyingPlan,
  BuyingPlanLine,
  ProductCatalogItem,
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
  fob_efob_rate: string; // FG per-unit FOB/EFOB rate (sheet value)
  job_rate: string; // FG per-unit JOB rate (sheet value)
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
    fob_efob_rate: line.fob_efob_rate?.toString() ?? '',
    job_rate: line.job_rate?.toString() ?? '',
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
    fob_efob_rate: '',
    job_rate: '',
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
  catalog = [],
  leadDays = { job: 30, efob: 45, fob: 90 },
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
  catalog?: ProductCatalogItem[];
  leadDays?: { job: number; efob: number; fob: number };
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
  const [collapsed, setCollapsed] = useState<Record<string, boolean>>({});
  // Input-table filters (Woven/Knitted, product state, PO type, code search).
  const [inputFabric, setInputFabric] = useState('');
  const [inputStatus, setInputStatus] = useState('');
  const [inputPoType, setInputPoType] = useState('');
  const [inputSearch, setInputSearch] = useState('');
  // View-mode grouping dimension (spec §2 — category, not product code, by default).
  const [groupBy, setGroupBy] = useState<'category' | 'subcategory' | 'weave' | 'code'>('category');

  const catalogByCode = useMemo(() => {
    const m: Record<string, { category: string | null; sub_category: string | null }> = {};
    for (const c of catalog) m[c.product_code] = { category: c.category, sub_category: c.sub_category };
    return m;
  }, [catalog]);

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
    // An ingested plan carries the sheet's own value / status / pending on the line —
    // show those verbatim. Only fall back to the live computation (approved standard
    // cost, replenishment, product master) when the line has no stored value.
    const storedValue = row.standard_value ? Number(row.standard_value) : 0;
    const valueToBeBought =
      storedValue > 0
        ? storedValue
        : cost
        ? jobQty * cost.job + fobQty * cost.fob + efobQty * cost.efob
        : 0;
    const storedPending =
      row.pending_quantity !== '' && row.pending_quantity != null
        ? Number(row.pending_quantity)
        : null;
    const pending = storedPending ?? pendingByCode[row.product_code] ?? null;
    const actual = actuals[row.product_code.trim().toUpperCase()] ?? { qty: 0, value: 0 };
    const remaining = Math.max(0, totalQty - actual.qty);
    return {
      row,
      totalQty,
      cost,
      // Flag only when there is neither a stored value nor an approved cost to value it.
      missingCost: totalQty > 0 && storedValue <= 0 && !cost,
      valueToBeBought,
      pending,
      actualQty: actual.qty,
      actualValue: actual.value,
      remaining,
      pctComplete:
        totalQty > 0 ? Math.min(100, Math.round((actual.qty / totalQty) * 100)) : 0,
      // Weave/category is the product master's, falling back to the stored line only
      // when the master has nothing for this code.
      fabricType: productMaster[row.product_code]?.fabric_type || row.fabric_type || 'Unspecified',
      // Product State is sourced from the product master (rolled up to the code),
      // falling back to the stored line only when the master has nothing for it.
      productStatus: productMaster[row.product_code]?.status || row.product_status || '—',
      // Garment category / sub-category (from the product catalog) — for Group By.
      category: catalogByCode[row.product_code]?.category || 'Uncategorised',
      subCategory: catalogByCode[row.product_code]?.sub_category || 'Uncategorised',
      // Red, but never blocking. Mahesh: show it, don't refuse it.
      overPlan: totalQty > 0 && actual.qty > totalQty,
    };
  });

  type ViewItem = (typeof view)[number];

  // Input-table filter options + filtered rows (edits still target row.key, so
  // filtering only narrows what's shown — never what's saved).
  const fabricOptions = [...new Set(view.map((v) => v.fabricType))].sort();
  const statusOptions = [...new Set(view.map((v) => v.productStatus))].sort();
  const inputSearchQ = inputSearch.trim().toLowerCase();
  // PO-type filter: a plan line splits across Job/FOB/E-FOB, so filter to lines
  // carrying quantity in the chosen type.
  const poTypeQty = (v: ViewItem, t: string) =>
    t === 'job'
      ? Number(v.row.job_work_qty)
      : t === 'fob'
        ? Number(v.row.fob_qty)
        : Number(v.row.efob_qty);
  const inputRows = view.filter(
    (v) =>
      (!inputFabric || v.fabricType === inputFabric) &&
      (!inputStatus || v.productStatus === inputStatus) &&
      (!inputPoType || poTypeQty(v, inputPoType) > 0) &&
      (!inputSearchQ || v.row.product_code.toLowerCase().includes(inputSearchQ)),
  );

  // The full sheet, line-for-line — every column the buying-plan sheet has, verbatim,
  // with per-column filters + sort (via FilterTable). Rates come from the stored line.
  const rate = (s: string) => (s === '' || s == null ? null : Number(s));
  const sheetCols: Column<ViewItem>[] = [
    { key: 'code', label: 'Product code', kind: 'mono', accessor: (v) => v.row.product_code },
    { key: 'category', label: 'Category', kind: 'text', accessor: (v) => v.fabricType },
    { key: 'fob_efob_rate', label: 'Buy value (FOB/E-FOB)', kind: 'num',
      accessor: (v) => rate(v.row.fob_efob_rate),
      render: (v) => (rate(v.row.fob_efob_rate) == null ? <span className="wf-subtle">—</span> : money.format(Number(v.row.fob_efob_rate))) },
    { key: 'job_rate', label: 'Buy value (Job)', kind: 'num',
      accessor: (v) => rate(v.row.job_rate),
      render: (v) => (rate(v.row.job_rate) == null ? <span className="wf-subtle">—</span> : money.format(Number(v.row.job_rate))) },
    { key: 'status', label: 'Product State', kind: 'text', accessor: (v) => v.productStatus },
    { key: 'pending', label: 'Pending qty', kind: 'num', accessor: (v) => v.pending },
    { key: 'job', label: 'Job', kind: 'num', accessor: (v) => Number(v.row.job_work_qty) },
    { key: 'efob', label: 'E-FOB', kind: 'num', accessor: (v) => Number(v.row.efob_qty) },
    { key: 'fob', label: 'FOB', kind: 'num', accessor: (v) => Number(v.row.fob_qty) },
    { key: 'total_qty', label: 'Total qty', kind: 'num', accessor: (v) => v.totalQty },
    { key: 'total_value', label: 'Total value', kind: 'num', accessor: (v) => v.valueToBeBought,
      render: (v) => (v.valueToBeBought ? money.format(v.valueToBeBought) : <span className="wf-subtle">—</span>) },
    { key: 'actual', label: 'Actual qty', kind: 'num', accessor: (v) => v.actualQty },
    { key: 'approval', label: 'Approval', kind: 'text', accessor: (v) => v.row.line_status || '—' },
  ];

  // View module works over products that actually have a planned quantity.
  const planned = view.filter((v) => v.totalQty > 0);
  // §7 time-bucket demand coverage: pending = 30-day ROP, so N-day coverage scales
  // linearly. Reads the lead-time day-counts from the Rules Master.
  const totalPending = planned.reduce((s, v) => s + (pendingByCode[v.row.product_code] ?? 0), 0);
  const coverage = (days: number) => Math.round((totalPending / 30) * days);
  const buckets = [
    { key: 'job', label: 'Job Work', ruleKey: 'lead_days_job', days: leadDays.job, qty: coverage(leadDays.job) },
    { key: 'efob', label: 'E-FOB', ruleKey: 'lead_days_efob', days: leadDays.efob, qty: coverage(leadDays.efob) },
    { key: 'fob', label: 'FOB', ruleKey: 'lead_days_fob', days: leadDays.fob, qty: coverage(leadDays.fob) },
  ];
  const viewRows = planned;
  const groupKey = (item: ViewItem) =>
    groupBy === 'category'
      ? item.category
      : groupBy === 'subcategory'
        ? item.subCategory
        : groupBy === 'code'
          ? item.row.product_code
          : item.fabricType;
  const groups: [string, ViewItem[]][] = (() => {
    const m = new Map<string, ViewItem[]>();
    for (const item of viewRows) {
      const k = groupKey(item);
      const list = m.get(k) ?? [];
      list.push(item);
      m.set(k, list);
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

  // §1 macro snapshot: total blended request broken down by category (real plan data).
  const blendedByCategory = (() => {
    const m = new Map<string, number>();
    for (const v of planned) m.set(v.category, (m.get(v.category) ?? 0) + v.valueToBeBought);
    return [...m.entries()].filter(([, val]) => val > 0).sort((a, b) => b[1] - a[1]);
  })();

  // Item 3 — planned value (₹) broken down by PO type: sum(qty × standard cost) per
  // type. Its own dimension, alongside the qty-level time buckets. Only lines with an
  // approved cost contribute (a stored blended value can't be split across types).
  const valueByPoType = planned.reduce(
    (acc, v) => {
      if (v.cost) {
        acc.job += Number(v.row.job_work_qty) * v.cost.job;
        acc.fob += Number(v.row.fob_qty) * v.cost.fob;
        acc.efob += Number(v.row.efob_qty) * v.cost.efob;
      }
      return acc;
    },
    { job: 0, fob: 0, efob: 0 },
  );
  const valueByPoTypeTotal = valueByPoType.job + valueByPoType.fob + valueByPoType.efob;

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
    const c = code.trim();
    if (!c) return;
    // Clear filters + search to the code so the added/existing row is visible
    // immediately (the grid can be long — otherwise the add looks like nothing
    // happened).
    setInputFabric('');
    setInputStatus('');
    setInputPoType('');
    setInputSearch(c);
    if (rows.some((r) => r.product_code === c)) {
      setMessage(`${c} is already in the plan — showing it below.`);
      return;
    }
    setRows((current) => [...current, blankDraft(c, `new-${c}-${Date.now()}`)]);
    setMessage(`Added ${c}. Clear the filter to see the whole plan.`);
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
      <MacroSnapshot
        demandQty={totalPending}
        blendedValue={plannedTotals.value}
        byCategory={blendedByCategory}
      />
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
          <StatusBadge status={status} edited={plan?.edited_before_approval} />
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
            <ProductPicker
              items={catalog}
              exclude={used}
              onPick={(code) => addRow(code)}
              placeholder="Add product — search code or name…"
            />
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
        <TimeBuckets buckets={buckets} isAdmin={role === 'admin'} />
        <ValueByPoType value={valueByPoType} total={valueByPoTypeTotal} />
        <PlanView
          groups={groups}
          totals={plannedTotals}
          pctBought={pctBought}
          collapsed={collapsed}
          setCollapsed={setCollapsed}
          plannedCount={planned.length}
          groupBy={groupBy}
          setGroupBy={setGroupBy}
        />
        <div className="wf-section-head" style={{ marginTop: 18 }}>
          <h3>Plan detail — every line, as on the sheet</h3>
          <span className="wf-subtle">{view.length} products · filter or sort any column</span>
        </div>
        <FilterTable
          rows={view}
          columns={sheetCols}
          rowKey={(v) => v.row.key}
          unit="lines"
          pageSize={100}
          searchPlaceholder="Product code or status"
          emptyText="No lines in this plan."
        />
        </>
      )}

      {mode === 'input' && (
      <>
      <div className="wf-toolbar wf-filter-bar">
        <input
          className="wf-search"
          placeholder="Filter product code…"
          value={inputSearch}
          onChange={(e) => setInputSearch(e.target.value)}
        />
        <label className="wf-inline-field">
          Woven / Knitted
          <select value={inputFabric} onChange={(e) => setInputFabric(e.target.value)}>
            <option value="">All</option>
            {fabricOptions.map((f) => (
              <option key={f} value={f}>{f}</option>
            ))}
          </select>
        </label>
        <label className="wf-inline-field">
          Product State
          <select value={inputStatus} onChange={(e) => setInputStatus(e.target.value)}>
            <option value="">All</option>
            {statusOptions.map((s) => (
              <option key={s} value={s}>{s}</option>
            ))}
          </select>
        </label>
        <label className="wf-inline-field">
          PO type
          <select value={inputPoType} onChange={(e) => setInputPoType(e.target.value)}>
            <option value="">All</option>
            <option value="job">Job Work</option>
            <option value="fob">FOB</option>
            <option value="efob">E-FOB</option>
          </select>
        </label>
        <span className="wf-subtle">
          {inputRows.length} of {view.length} shown
          {(inputFabric || inputStatus || inputPoType || inputSearchQ) && (
            <button
              type="button"
              className="wf-btn wf-btn-ghost wf-btn-sm"
              onClick={() => { setInputFabric(''); setInputStatus(''); setInputPoType(''); setInputSearch(''); }}
            >
              Clear
            </button>
          )}
        </span>
      </div>
      <div className="table-panel wf-grid-panel">
        <div className="table-scroll">
          <table className="wide-table wf-grid">
            <thead>
              <tr>
                <th>Product code</th>
                <th>Product State</th>
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
              {inputRows.map(({ row, totalQty, cost, missingCost, valueToBeBought, pending, productStatus, fabricType, actualQty, actualValue, overPlan }) => (
                <tr key={row.key} className={overPlan ? 'wf-row-over' : ''}>
                  <td className="mono">{row.product_code}</td>
                  <td>{productStatus}</td>
                  <td>{fabricType}</td>
                  <td className="num wf-cell-calc">
                    {pending != null ? fmt.format(pending) : '—'}
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
              {!inputRows.length && (
                <tr>
                  <td colSpan={editable ? 14 : 13} className="wf-empty-cell">
                    {view.length
                      ? 'No products match the filters.'
                      : 'No product codes added yet. Discontinued variants are excluded automatically.'}
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
                if (result.ok) reloadWithToast();
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
  fabricType: string;
  productStatus: string;
  overPlan: boolean;
};

function Progress({ pct }: { pct: number }) {
  return (
    <div className="wf-progress">
      <div
        className="wf-progress-fill"
        style={{ width: `${Math.max(0, Math.min(100, pct))}%` }}
      />
    </div>
  );
}

/**
 * §1 — leadership macro snapshot: the four glance questions above the line-item
 * table. Sales-based figures (run rate, last-3-month) are shown as "not wired"
 * rather than faked — the Quantity-Sold→DOQ feed isn't live yet (Mahesh's flag).
 * Demand projection (from ROP/DOQ) and the total blended request (real plan value,
 * broken down by category) are surfaced from data that already exists.
 */
function MacroSnapshot({
  demandQty,
  blendedValue,
  byCategory,
}: {
  demandQty: number;
  blendedValue: number;
  byCategory: [string, number][];
}) {
  return (
    <div className="wf-macro">
      <div className="wf-macro-card wf-macro-gap">
        <span className="wf-macro-q">Run rate — revenue / qty sold</span>
        <strong className="wf-macro-val">—</strong>
        <span className="wf-subtle">sales feed not wired yet</span>
      </div>
      <div className="wf-macro-card wf-macro-gap">
        <span className="wf-macro-q">Last-3-month average</span>
        <strong className="wf-macro-val">—</strong>
        <span className="wf-subtle">sales feed not wired yet</span>
      </div>
      <div className="wf-macro-card">
        <span className="wf-macro-q">Demand projection</span>
        <strong className="wf-macro-val">{fmt.format(demandQty)} pcs</strong>
        <span className="wf-subtle">30-day, from ROP / DOQ</span>
      </div>
      <div className="wf-macro-card wf-macro-wide">
        <span className="wf-macro-q">Total blended request (this plan)</span>
        <strong className="wf-macro-val">{money.format(blendedValue)}</strong>
        <span className="wf-macro-cats">
          {byCategory.length ? (
            byCategory.map(([cat, val]) => (
              <span key={cat} className="wf-macro-chip">{cat} · {money.format(val)}</span>
            ))
          ) : (
            <span className="wf-subtle">no planned value yet</span>
          )}
        </span>
      </div>
    </div>
  );
}

/**
 * §7 — coverage by PO-type lead time. Three windows (Job/EFOB/FOB) show the pieces
 * needed to cover each lead time, so leadership can size the split at freeze time.
 * Day-counts come from the editable Rules Master (sd_analytics_rule); admins edit
 * them inline.
 */
/**
 * Item 3 — planned value (₹) by PO type. Its own dimension alongside the qty-level
 * coverage buckets: sum(qty × standard cost) for Job Work / E-FOB / FOB, plus the total.
 */
function ValueByPoType({
  value,
  total,
}: {
  value: { job: number; fob: number; efob: number };
  total: number;
}) {
  const rows = [
    { key: 'job', label: 'Job Work', amount: value.job },
    { key: 'efob', label: 'E-FOB', amount: value.efob },
    { key: 'fob', label: 'FOB', amount: value.fob },
  ];
  return (
    <div className="wf-buckets">
      <div className="wf-buckets-head">
        <h3>Planned value by PO type</h3>
        <span className="wf-subtle">₹ to be bought per type · qty × approved standard cost</span>
      </div>
      <div className="wf-buckets-row">
        {rows.map((r) => (
          <div className="wf-bucket-card" key={r.key}>
            <span className="wf-bucket-type">{r.label}</span>
            <strong className="wf-bucket-qty">{r.amount ? money.format(r.amount) : '—'}</strong>
            <span className="wf-bucket-days">
              {total > 0 ? `${Math.round((r.amount / total) * 100)}% of plan value` : 'no priced lines'}
            </span>
          </div>
        ))}
        <div className="wf-bucket-card" key="total">
          <span className="wf-bucket-type">Total</span>
          <strong className="wf-bucket-qty">{total ? money.format(total) : '—'}</strong>
          <span className="wf-bucket-days">all PO types</span>
        </div>
      </div>
    </div>
  );
}

function TimeBuckets({
  buckets,
  isAdmin,
}: {
  buckets: { key: string; label: string; ruleKey: string; days: number; qty: number }[];
  isAdmin: boolean;
}) {
  const [editing, setEditing] = useState<string | null>(null);
  const [val, setVal] = useState('');
  const [busy, start] = useTransition();

  function save(ruleKey: string) {
    const fd = new FormData();
    fd.set('rule_key', ruleKey);
    fd.set('value', val);
    start(async () => {
      const res = await saveAnalyticsRule(fd);
      setEditing(null);
      if (res.ok) reloadWithToast();
    });
  }

  return (
    <div className="wf-buckets">
      <div className="wf-buckets-head">
        <h3>Coverage by PO-type lead time</h3>
        <span className="wf-subtle">pieces needed to cover each window · demand from 30-day ROP</span>
      </div>
      <div className="wf-buckets-row">
        {buckets.map((b) => (
          <div className="wf-bucket-card" key={b.key}>
            <span className="wf-bucket-type">{b.label}</span>
            <strong className="wf-bucket-qty">{fmt.format(b.qty)} pcs</strong>
            {editing === b.key ? (
              <span className="wf-issue-row">
                <input
                  className="wf-mini-input"
                  type="number"
                  min={1}
                  value={val}
                  onChange={(e) => setVal(e.target.value)}
                />
                <button type="button" className="wf-btn wf-btn-primary wf-btn-sm" disabled={busy} onClick={() => save(b.ruleKey)}>
                  Save
                </button>
                <button type="button" className="wf-btn wf-btn-ghost wf-btn-sm" onClick={() => setEditing(null)}>
                  Cancel
                </button>
              </span>
            ) : (
              <span className="wf-bucket-days">
                {b.days}-day window
                {isAdmin && (
                  <button
                    type="button"
                    className="wf-btn wf-btn-ghost wf-btn-sm"
                    onClick={() => { setEditing(b.key); setVal(String(b.days)); }}
                  >
                    edit
                  </button>
                )}
              </span>
            )}
          </div>
        ))}
      </div>
    </div>
  );
}

function PlanView({
  groups,
  totals,
  pctBought,
  collapsed,
  setCollapsed,
  plannedCount,
  groupBy,
  setGroupBy,
}: {
  groups: [string, ViewItemFull[]][];
  totals: { qty: number; value: number; actualQty: number; actualValue: number };
  pctBought: number;
  collapsed: Record<string, boolean>;
  setCollapsed: (updater: (c: Record<string, boolean>) => Record<string, boolean>) => void;
  plannedCount: number;
  groupBy: 'category' | 'subcategory' | 'weave' | 'code';
  setGroupBy: (v: 'category' | 'subcategory' | 'weave' | 'code') => void;
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
      </div>

      <div className="wf-toolbar">
        <label className="wf-inline-field">
          Group by
          <select value={groupBy} onChange={(e) => setGroupBy(e.target.value as typeof groupBy)}>
            <option value="category">Category</option>
            <option value="subcategory">Sub-category</option>
            <option value="weave">Woven / Knitted</option>
            <option value="code">Product code</option>
          </select>
        </label>
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
                    <div className="wf-plan-line" key={it.row.key}>
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
                        <Progress pct={it.pctComplete} />
                      </span>
                      <span className="num wf-subtle">{it.pctComplete}%</span>
                      <span className="num wf-subtle">
                        {it.remaining > 0 ? `${fmt.format(it.remaining)} left` : 'done'}
                      </span>
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
