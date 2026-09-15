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
  pickerItems = [],
  restrictPicker = false,
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
  /** Products offered in the add-product picker (Standard-Cost-only when restricted). */
  pickerItems?: ProductCatalogItem[];
  /** When true, only Standard-Cost products are selectable (no free-typed codes). */
  restrictPicker?: boolean;
  leadDays?: { job: number; efob: number; fob: number };
  role: SdRole;
}) {
  const status: SdStatus = plan?.status ?? 'draft';
  // Submitted / awaiting approval / approved: values are frozen at submission.
  const planLocked = status === 'submitted' || status === 'pending_l2' || status === 'approved';
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
  const [inputCategory, setInputCategory] = useState('');
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
    // Value rule: while the plan is being edited (draft / rework) it follows the
    // live latest-accepted rate; once submitted the value frozen at submission is
    // shown verbatim, so later rate changes never rewrite an in-flight/approved
    // plan. An ingested line with no live cost keeps its sheet value either way.
    const storedValue = row.standard_value ? Number(row.standard_value) : 0;
    const liveValue = cost ? jobQty * cost.job + fobQty * cost.fob + efobQty * cost.efob : 0;
    const useStored = storedValue > 0 && (planLocked || !cost);
    const valueToBeBought = useStored ? storedValue : liveValue;
    // Split by PO type for the value-by-type panel: live rates when live, else the
    // frozen value apportioned by quantity share.
    const byType = useStored
      ? {
          job: totalQty ? (storedValue * jobQty) / totalQty : 0,
          fob: totalQty ? (storedValue * fobQty) / totalQty : 0,
          efob: totalQty ? (storedValue * efobQty) / totalQty : 0,
        }
      : cost
      ? { job: jobQty * cost.job, fob: fobQty * cost.fob, efob: efobQty * cost.efob }
      : { job: 0, fob: 0, efob: 0 };
    // A rate of 0 for a PO type that has quantity is as good as missing — flag it
    // rather than silently valuing those pieces at ₹0.
    const rateMissing =
      !cost ||
      (jobQty > 0 && !cost.job) ||
      (fobQty > 0 && !cost.fob) ||
      (efobQty > 0 && !cost.efob);
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
      missingCost: totalQty > 0 && !useStored && rateMissing,
      byType,
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
  // One predicate for both modes: the same filters narrow the Input table, the
  // grouped View, and the View's plan-detail table (edits still target row.key).
  const matchesFilters = (v: ViewItem) =>
    (!inputFabric || v.fabricType === inputFabric) &&
    (!inputCategory || v.category === inputCategory) &&
    (!inputStatus || v.productStatus === inputStatus) &&
    (!inputPoType || poTypeQty(v, inputPoType) > 0) &&
    (!inputSearchQ || v.row.product_code.toLowerCase().includes(inputSearchQ));
  const inputRows = view.filter(matchesFilters);

  // The full sheet, line-for-line — every column the buying-plan sheet has, verbatim,
  // with per-column filters + sort (via FilterTable). Rates come from the stored line.
  const rate = (s: string) => (s === '' || s == null ? null : Number(s));
  const sheetCols: Column<ViewItem>[] = [
    { key: 'code', label: 'Product code', kind: 'mono', source: 'easyecom', accessor: (v) => v.row.product_code },
    { key: 'category', label: 'Category', kind: 'text', source: 'easyecom', accessor: (v) => v.fabricType },
    { key: 'fob_efob_rate', label: 'Buy value (FOB/E-FOB)', kind: 'num',
      accessor: (v) => rate(v.row.fob_efob_rate),
      render: (v) => (rate(v.row.fob_efob_rate) == null ? <span className="wf-subtle">—</span> : money.format(Number(v.row.fob_efob_rate))) },
    { key: 'job_rate', label: 'Buy value (Job)', kind: 'num',
      accessor: (v) => rate(v.row.job_rate),
      render: (v) => (rate(v.row.job_rate) == null ? <span className="wf-subtle">—</span> : money.format(Number(v.row.job_rate))) },
    { key: 'status', label: 'Product State', kind: 'text', source: 'easyecom', accessor: (v) => v.productStatus },
    { key: 'pending', label: 'Pending qty', kind: 'num', source: 'bigquery', accessor: (v) => v.pending },
    { key: 'job', label: 'Job', kind: 'num', accessor: (v) => Number(v.row.job_work_qty) },
    { key: 'efob', label: 'E-FOB', kind: 'num', accessor: (v) => Number(v.row.efob_qty) },
    { key: 'fob', label: 'FOB', kind: 'num', accessor: (v) => Number(v.row.fob_qty) },
    { key: 'total_qty', label: 'Total qty', kind: 'num', source: 'computed', accessor: (v) => v.totalQty },
    { key: 'total_value', label: 'Total value', kind: 'num', source: 'computed', accessor: (v) => v.valueToBeBought,
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
  const viewRows = planned.filter(matchesFilters);
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

  // Filters are shared by the View and Input modes (same state, so they persist when
  // switching). Garment-category options come from the catalog — the View groups by them.
  const categoryOptions = [...new Set(view.map((v) => v.category))].sort();
  const hasFilters = Boolean(inputFabric || inputStatus || inputPoType || inputCategory || inputSearchQ);
  const clearFilters = () => {
    setInputFabric('');
    setInputStatus('');
    setInputPoType('');
    setInputCategory('');
    setInputSearch('');
  };
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

  // Item 3 — planned value (₹) broken down by PO type. Uses the same per-line value
  // as the headline total (frozen or live), so the three type cards reconcile to it.
  const valueByPoType = planned.reduce(
    (acc, v) => {
      acc.job += v.byType.job;
      acc.fob += v.byType.fob;
      acc.efob += v.byType.efob;
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
      if (result.ok) {
        setMessage(result.message ?? 'Saved.');
        // First save of a month creates the plan — refresh so the server-provided
        // plan (id / status) arrives and Submit becomes available.
        if (!plan?.id) reloadWithToast(result.message ?? 'Saved.');
      } else setError(result.error);
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

  // "Needs attention" — the four honest signals the plan itself carries. No thresholds
  // invented: each is a plain count of lines in a definite state.
  const attention = {
    missingCost: view.filter((v) => v.missingCost).length,
    approvalPending:
      planLocked && status !== 'approved'
        ? planned.filter((v) => v.row.line_status !== 'approved').length
        : 0,
    notStarted: planned.filter((v) => v.actualQty === 0).length,
    overPlan: planned.filter((v) => v.overPlan).length,
  };
  const attentionTotal =
    attention.missingCost + attention.approvalPending + attention.notStarted + attention.overPlan;

  // Export = the Plan-detail table, respecting the current filters.
  function exportCsv() {
    const rows = view.filter(matchesFilters).map((v) => [
      v.row.product_code,
      v.category,
      v.productStatus,
      String(v.totalQty),
      String(Math.round(v.valueToBeBought)),
      v.row.job_work_qty,
      v.row.efob_qty,
      v.row.fob_qty,
      String(v.actualQty),
      `${v.pctComplete}%`,
      v.row.line_status || '',
    ]);
    downloadCsv(
      `buying-plan-${planMonth.slice(0, 7)}.csv`,
      ['product_code', 'category', 'state', 'plan_qty', 'plan_value', 'job', 'efob', 'fob', 'actual_qty', 'bought_pct', 'approval'],
      rows,
    );
  }

  const shownCount = mode === 'view' ? viewRows.length : inputRows.length;
  const totalCount = mode === 'view' ? planned.length : view.length;

  // Shared filter toolbar (sticky card). Group-by only applies to the grouped View.
  const toolbar = (
    <div className="bp-toolbar">
      <input
        className="bp-search"
        placeholder="Search product code…"
        value={inputSearch}
        onChange={(e) => setInputSearch(e.target.value)}
      />
      <select aria-label="Category" value={inputCategory} onChange={(e) => setInputCategory(e.target.value)}>
        <option value="">Category: All</option>
        {categoryOptions.map((c) => (
          <option key={c} value={c}>{c}</option>
        ))}
      </select>
      <select aria-label="Woven or knitted" value={inputFabric} onChange={(e) => setInputFabric(e.target.value)}>
        <option value="">Woven / Knitted: All</option>
        {fabricOptions.map((f) => (
          <option key={f} value={f}>{f}</option>
        ))}
      </select>
      <select aria-label="Product state" value={inputStatus} onChange={(e) => setInputStatus(e.target.value)}>
        <option value="">State: All</option>
        {statusOptions.map((s) => (
          <option key={s} value={s}>{s}</option>
        ))}
      </select>
      <select aria-label="PO type" value={inputPoType} onChange={(e) => setInputPoType(e.target.value)}>
        <option value="">PO type: All</option>
        <option value="job">Job Work</option>
        <option value="fob">FOB</option>
        <option value="efob">E-FOB</option>
      </select>
      {mode === 'view' && (
        <select aria-label="Group by" value={groupBy} onChange={(e) => setGroupBy(e.target.value as typeof groupBy)}>
          <option value="category">Group by: Category</option>
          <option value="subcategory">Group by: Sub-category</option>
          <option value="weave">Group by: Woven / Knitted</option>
          <option value="code">Group by: Product code</option>
        </select>
      )}
      <span className="bp-toolbar-count">
        {shownCount} of {totalCount} shown
        {hasFilters && (
          <button type="button" className="wf-btn wf-btn-ghost wf-btn-sm" onClick={clearFilters}>
            Clear
          </button>
        )}
      </span>
    </div>
  );

  return (
    <>
      {/* Page bar: month · status · View/Input on the left; actions on the right. */}
      <div className="bp-pagebar">
        <div className="bp-pagebar-left">
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
            <button type="button" className={mode === 'view' ? 'active' : ''} onClick={() => setMode('view')}>
              <Eye size={14} /> View
            </button>
            <button type="button" className={mode === 'input' ? 'active' : ''} onClick={() => setMode('input')}>
              <ClipboardList size={14} /> Input
            </button>
          </div>
        </div>

        <div className="bp-pagebar-right">
          {editable && mode === 'input' && (
            <>
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
                items={restrictPicker ? pickerItems : catalog}
                exclude={used}
                allowFreeText={!restrictPicker}
                onPick={(code) => addRow(code)}
                placeholder={restrictPicker ? 'Add product — from Standard Cost…' : 'Add product — search code or name…'}
              />
              <button type="button" className="wf-btn wf-btn-ghost" onClick={addAll} disabled={!available.length}>
                <Plus size={15} /> Add all
              </button>
            </>
          )}
          <button type="button" className="wf-btn wf-btn-ghost" onClick={exportCsv} disabled={!view.length}>
            <Download size={15} /> Export
          </button>
          {editable && mode === 'input' && (
            <button type="button" className="wf-btn wf-btn-ghost" onClick={save} disabled={pending}>
              <Save size={15} /> {pending ? 'Saving…' : 'Save draft'}
            </button>
          )}
          {canSubmit(role, status) && (
            <button
              type="button"
              className="wf-btn wf-btn-primary"
              onClick={submit}
              disabled={pending || !plan?.id}
              title={!plan?.id ? 'Save the plan first' : undefined}
            >
              <Send size={15} /> Submit for approval
            </button>
          )}
        </div>
      </div>

      {!isPlanWindowOpen(planMonth) && (
        <Notice tone="warn">
          The window for {monthLabel(planMonth)} opens seven days before the month starts. You can still draft ahead.
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
        <div className="bp-layout">
          <div className="bp-stack">
            <OverviewCard
              pctBought={pctBought}
              issuedQty={plannedTotals.actualQty}
              plannedQty={plannedTotals.qty}
              plannedValue={plannedTotals.value}
              demandQty={totalPending}
              issuedValue={plannedTotals.actualValue}
              byCategory={blendedByCategory}
            />

            <div className="bp-sticky">
              <div className="bp-card bp-toolbar-card">{toolbar}</div>
            </div>

            <PlanGroups
              groups={groups}
              groupBy={groupBy}
              collapsed={collapsed}
              setCollapsed={setCollapsed}
              plannedCount={planned.length}
            />

            <section className="bp-card">
              <div className="bp-cardhead">
                <h2>Plan detail</h2>
                <span className="wf-subtle">{view.length} products · every line as on the sheet · filter or sort any column</span>
              </div>
              <div className="bp-cardbody bp-cardbody-flush">
                <FilterTable
                  rows={view.filter(matchesFilters)}
                  columns={sheetCols}
                  rowKey={(v) => v.row.key}
                  defaultSource="supabase"
                  unit="lines"
                  pageSize={100}
                  searchPlaceholder="Product code or status"
                  emptyText="No lines in this plan."
                  download={{ filename: `buying-plan-${planMonth.slice(0, 7)}` }}
                />
              </div>
            </section>
          </div>

          <div className="bp-stack bp-rightcol">
            <AttentionCard counts={attention} total={attentionTotal} />
            <LeadTimesCard buckets={buckets} isAdmin={role === 'admin'} />
            <ValueByTypeCard
              value={valueByPoType}
              total={valueByPoTypeTotal}
              split={poTypeSplit(planned.map((v) => v.row))}
            />
          </div>
        </div>
      )}

      {mode === 'input' && (
        <>
          <div className="bp-sticky">
            <div className="bp-card bp-toolbar-card">{toolbar}</div>
          </div>
          <section className="bp-card">
            <div className="bp-cardhead">
              <h2>Fill the plan</h2>
              <span className="wf-subtle">
                Every active product is listed — zero out what you will not make. Allocation may exceed pending
                quantity: FOB orders run ahead of demand because the vendor holds the stock.
              </span>
            </div>
            <div className="bp-cardbody bp-cardbody-flush">
              <div className="table-panel wf-grid-panel bp-input-panel">
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
                          <td className="num wf-cell-calc">{pending != null ? fmt.format(pending) : '—'}</td>
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
                            {missingCost ? <span className="wf-over-tag">no approved cost</span> : money.format(valueToBeBought)}
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
                                onClick={() => setRows((current) => current.filter((item) => item.key !== row.key))}
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
            </div>
          </section>

          {canApprove(role, status) && plan && (
            <div className="bp-card bp-cardbody">
              <ApprovalBar
                entityType="buying_plan"
                entityId={String(plan.id)}
                entityLabel={`Buying plan ${planMonth.slice(0, 7)}`}
                onDone={(result) => {
                  if (result.ok) reloadWithToast();
                }}
              />
            </div>
          )}
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
  category: string;
  subCategory: string;
  overPlan: boolean;
};

function Progress({ pct, flush = false }: { pct: number; flush?: boolean }) {
  return (
    <div className={`bp-progress${flush ? ' m0' : ''}`}>
      <span style={{ width: `${Math.max(0, Math.min(100, pct))}%` }} />
    </div>
  );
}

function Badge({ tone, children }: { tone: 'green' | 'yellow' | 'red' | 'gray'; children: React.ReactNode }) {
  return <span className={`bp-badge ${tone}`}>{children}</span>;
}

// Compact rupee for tiles: ₹1.53 Cr / ₹49.86 L / ₹94,500.
function inr(v: number) {
  const abs = Math.abs(v);
  if (abs >= 1e7) return `₹${(v / 1e7).toFixed(2)} Cr`;
  if (abs >= 1e5) return `₹${(v / 1e5).toFixed(2)} L`;
  return money.format(v);
}

/**
 * Plan overview — the four glance figures. Buying progress (issued vs planned pcs),
 * total plan value, demand projection (30-day ROP/DOQ) and issued value. Sales-based
 * figures (run rate, last-3-month) are still not wired, so they are stated as a gap
 * rather than shown as empty tiles.
 */
function OverviewCard({
  pctBought,
  issuedQty,
  plannedQty,
  plannedValue,
  demandQty,
  issuedValue,
  byCategory,
}: {
  pctBought: number;
  issuedQty: number;
  plannedQty: number;
  plannedValue: number;
  demandQty: number;
  issuedValue: number;
  byCategory: [string, number][];
}) {
  const remaining = Math.max(0, plannedQty - issuedQty);
  return (
    <section className="bp-card">
      <div className="bp-cardhead">
        <h2>Plan overview</h2>
        <span className="wf-subtle">Run rate and last-3-month average: sales feed not wired yet</span>
      </div>
      <div className="bp-cardbody">
        <div className="bp-metrics">
          <div className="bp-metric">
            <div className="label">Buying progress</div>
            <div className="value">{pctBought}%</div>
            <div className="sub">{fmt.format(issuedQty)} of {fmt.format(plannedQty)} pcs issued</div>
            <Progress pct={pctBought} />
          </div>
          <div className="bp-metric">
            <div className="label">Total plan value</div>
            <div className="value">{plannedValue ? inr(plannedValue) : '—'}</div>
            <div className="sub">
              {fmt.format(plannedQty)} pcs
              {byCategory.length > 0 && ` · ${byCategory.slice(0, 2).map(([c, v]) => `${c} ${inr(v)}`).join(' · ')}`}
            </div>
          </div>
          <div className="bp-metric">
            <div className="label">Demand projection</div>
            <div className="value">{fmt.format(demandQty)} pcs</div>
            <div className="sub">30-day, from ROP / DOQ</div>
          </div>
          <div className="bp-metric">
            <div className="label">Issued value</div>
            <div className="value">{issuedValue ? inr(issuedValue) : '—'}</div>
            <div className="sub">{fmt.format(remaining)} pcs remaining</div>
          </div>
        </div>
      </div>
    </section>
  );
}

function AttentionCard({
  counts,
  total,
}: {
  counts: { missingCost: number; approvalPending: number; notStarted: number; overPlan: number };
  total: number;
}) {
  const items: { key: string; dot: 'red' | 'yellow' | 'green'; title: string; sub: string; n: number }[] = [
    { key: 'cost', dot: 'red', title: 'Missing approved cost', sub: 'Blocks plan value visibility', n: counts.missingCost },
    { key: 'approval', dot: 'yellow', title: 'Approval pending', sub: 'Lines waiting for action', n: counts.approvalPending },
    { key: 'over', dot: 'red', title: 'Over plan', sub: 'Issued above the planned qty', n: counts.overPlan },
    { key: 'start', dot: 'yellow', title: 'Not started', sub: 'Planned, nothing issued yet', n: counts.notStarted },
  ];
  const live = items.filter((i) => i.n > 0);
  return (
    <section className="bp-card">
      <div className="bp-cardhead">
        <h2>Needs attention</h2>
        <Badge tone={total ? 'red' : 'green'}>{total ? `${total} item${total === 1 ? '' : 's'}` : 'All clear'}</Badge>
      </div>
      <div className="bp-cardbody bp-attention">
        {live.length ? (
          live.map((i) => (
            <div className="bp-issue" key={i.key}>
              <div className="left">
                <span className={`bp-dot ${i.dot}`} />
                <div>
                  <b>{i.title}</b>
                  <span>{i.sub}</span>
                </div>
              </div>
              <strong>{i.n}</strong>
            </div>
          ))
        ) : (
          <span className="wf-subtle">Nothing flagged for this plan.</span>
        )}
      </div>
    </section>
  );
}

/**
 * PO lead times (Rules Master day-counts; admins edit inline) with the pieces needed
 * to cover each window — demand from the 30-day ROP.
 */
function LeadTimesCard({
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
    <section className="bp-card">
      <div className="bp-cardhead">
        <h2>PO lead times</h2>
        <span className="wf-subtle">coverage from 30-day ROP</span>
      </div>
      <div className="bp-cardbody">
        {buckets.map((b) => (
          <div className="bp-summaryrow" key={b.key}>
            <span>
              {b.label}
              <small className="bp-summary-sub">{fmt.format(b.qty)} pcs to cover</small>
            </span>
            {editing === b.key ? (
              <span className="wf-issue-row">
                <input className="wf-mini-input" type="number" min={1} value={val} onChange={(e) => setVal(e.target.value)} />
                <button type="button" className="wf-btn wf-btn-primary wf-btn-sm" disabled={busy} onClick={() => save(b.ruleKey)}>
                  Save
                </button>
                <button type="button" className="wf-btn wf-btn-ghost wf-btn-sm" onClick={() => setEditing(null)}>
                  Cancel
                </button>
              </span>
            ) : (
              <b>
                {b.days} days
                {isAdmin && (
                  <button
                    type="button"
                    className="wf-btn wf-btn-ghost wf-btn-sm"
                    style={{ marginLeft: 8 }}
                    onClick={() => { setEditing(b.key); setVal(String(b.days)); }}
                  >
                    Edit
                  </button>
                )}
              </b>
            )}
          </div>
        ))}
      </div>
    </section>
  );
}

/** Job / FOB / E-FOB quantity split for a set of plan lines (each line splits across the three). */
function poTypeSplit(rows: Draft[]) {
  return rows.reduce(
    (a, r) => ({
      job: a.job + (Number(r.job_work_qty) || 0),
      fob: a.fob + (Number(r.fob_qty) || 0),
      efob: a.efob + (Number(r.efob_qty) || 0),
    }),
    { job: 0, fob: 0, efob: 0 },
  );
}

/** "JOB 675 · E-FOB 255" — only the PO types that carry quantity. */
function splitText(split: { job: number; fob: number; efob: number }) {
  const parts: string[] = [];
  if (split.job) parts.push(`JOB ${fmt.format(split.job)}`);
  if (split.efob) parts.push(`E-FOB ${fmt.format(split.efob)}`);
  if (split.fob) parts.push(`FOB ${fmt.format(split.fob)}`);
  return parts.length ? parts.join(' · ') : '—';
}

/**
 * Planned value by PO type — ₹ to be bought per type with its share of the plan value,
 * plus the quantity proposed per type. Same per-line value as the headline total, so
 * the rows reconcile to it.
 */
function ValueByTypeCard({
  value,
  total,
  split,
}: {
  value: { job: number; fob: number; efob: number };
  total: number;
  split: { job: number; fob: number; efob: number };
}) {
  const rows = [
    { key: 'job', label: 'JOB', amount: value.job, qty: split.job },
    { key: 'efob', label: 'E-FOB', amount: value.efob, qty: split.efob },
    { key: 'fob', label: 'FOB', amount: value.fob, qty: split.fob },
  ];
  return (
    <section className="bp-card">
      <div className="bp-cardhead">
        <h2>Planned value by PO type</h2>
        <span className="wf-subtle">qty × approved standard cost</span>
      </div>
      <div className="bp-cardbody">
        {rows.map((r) => (
          <div className="bp-summaryrow" key={r.key}>
            <span>
              {r.label}
              <small className="bp-summary-sub">
                {fmt.format(r.qty)} pcs{total > 0 && r.amount ? ` · ${Math.round((r.amount / total) * 100)}% of value` : ''}
              </small>
            </span>
            <b>{r.amount ? inr(r.amount) : '—'}</b>
          </div>
        ))}
        <div className="bp-summaryrow">
          <span>Total</span>
          <b>{total ? inr(total) : '—'}</b>
        </div>
      </div>
    </section>
  );
}

const GROUP_LABEL: Record<'category' | 'subcategory' | 'weave' | 'code', string> = {
  category: 'category',
  subcategory: 'sub-category',
  weave: 'woven / knitted',
  code: 'product code',
};

/** Grouped plan: one collapsible block per group with plan qty/value, progress and per-product rows. */
function PlanGroups({
  groups,
  groupBy,
  collapsed,
  setCollapsed,
  plannedCount,
}: {
  groups: [string, ViewItemFull[]][];
  groupBy: 'category' | 'subcategory' | 'weave' | 'code';
  collapsed: Record<string, boolean>;
  setCollapsed: (updater: (c: Record<string, boolean>) => Record<string, boolean>) => void;
  plannedCount: number;
}) {
  return (
    <section className="bp-card">
      <div className="bp-cardhead">
        <h2>Buying plan by {GROUP_LABEL[groupBy]}</h2>
        <div className="bp-actions">
          <button
            type="button"
            className="wf-btn wf-btn-ghost wf-btn-sm"
            onClick={() => setCollapsed(() => Object.fromEntries(groups.map(([g]) => [g, true])))}
          >
            Collapse all
          </button>
          <button type="button" className="wf-btn wf-btn-ghost wf-btn-sm" onClick={() => setCollapsed(() => ({}))}>
            Expand all
          </button>
        </div>
      </div>
      <div className="bp-cardbody">
        {!plannedCount ? (
          <div className="empty-state">
            <p>Nothing planned yet — switch to Input to fill this month’s buying plan.</p>
          </div>
        ) : !groups.length ? (
          <div className="wf-subtle">No products match the filters.</div>
        ) : (
          groups.map(([name, items]) => {
            const gt = items.reduce(
              (a, it) => ({ qty: a.qty + it.totalQty, value: a.value + it.valueToBeBought, actualQty: a.actualQty + it.actualQty }),
              { qty: 0, value: 0, actualQty: 0 },
            );
            const gPct = gt.qty > 0 ? Math.min(100, Math.round((gt.actualQty / gt.qty) * 100)) : 0;
            const isCollapsed = collapsed[name];
            const tone: 'green' | 'yellow' | 'gray' = gPct >= 50 ? 'green' : gPct > 0 ? 'yellow' : 'gray';
            return (
              <div className="bp-category" key={name}>
                <button type="button" className="bp-cathead" onClick={() => setCollapsed((c) => ({ ...c, [name]: !c[name] }))}>
                  <div className="bp-catname">
                    <b>
                      {isCollapsed ? <ChevronRight size={14} /> : <ChevronDown size={14} />} {name}
                    </b>
                    <span>{items.length} product{items.length === 1 ? '' : 's'}</span>
                  </div>
                  <div className="bp-num"><b>{fmt.format(gt.qty)} pcs</b><span>Plan qty</span></div>
                  <div className="bp-num"><b>{gt.value ? inr(gt.value) : '—'}</b><span>Plan value</span></div>
                  <div className="bp-split">{splitText(poTypeSplit(items.map((it) => it.row)))}</div>
                  <div><Progress pct={gPct} flush /></div>
                  <div><Badge tone={tone}>{gPct}%</Badge></div>
                </button>
                {!isCollapsed &&
                  items.map((it) => {
                    const badge = it.missingCost
                      ? { tone: 'red' as const, text: 'Cost missing' }
                      : it.overPlan
                        ? { tone: 'red' as const, text: 'Over plan' }
                        : it.pctComplete >= 100
                          ? { tone: 'green' as const, text: 'Fully bought' }
                          : it.pctComplete > 0
                            ? { tone: 'yellow' as const, text: `${it.pctComplete}% bought` }
                            : { tone: 'gray' as const, text: '0% bought' };
                    return (
                      <div className="bp-skurow" key={it.row.key}>
                        <div className="bp-sku">
                          <b className="mono">{it.row.product_code}</b>
                          <span>{it.productStatus}</span>
                        </div>
                        <div>{fmt.format(it.totalQty)} pcs</div>
                        <div>{it.missingCost ? <span className="wf-subtle">—</span> : money.format(it.valueToBeBought)}</div>
                        <div className="bp-split">{splitText(poTypeSplit([it.row]))}</div>
                        <div>
                          <Progress pct={it.pctComplete} flush />
                          <small className="bp-summary-sub">
                            {fmt.format(it.actualQty)} issued{it.remaining > 0 ? ` · ${fmt.format(it.remaining)} left` : ''}
                          </small>
                        </div>
                        <div><Badge tone={badge.tone}>{badge.text}</Badge></div>
                      </div>
                    );
                  })}
              </div>
            );
          })
        )}
      </div>
    </section>
  );
}
