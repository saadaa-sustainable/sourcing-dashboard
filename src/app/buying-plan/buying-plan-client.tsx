'use client';

import { useEffect, useMemo, useRef, useState, useTransition } from 'react';
import { reloadWithToast } from '@/lib/toast';
import {
  ChevronDown,
  ChevronRight,
  ClipboardList,
  Download,
  Eye,
  Maximize2,
  Minimize2,
  MoreHorizontal,
  Plus,
  Save,
  Search,
  Send,
  Trash2,
  Upload,
  X,
} from 'lucide-react';
import { requestPlanAmendment, saveAnalyticsRule, saveBuyingPlan, submitBuyingPlan } from '@/lib/forms/actions';
import { csvObjects, downloadCsv } from '@/lib/csv';
import { FilterTable, type Column } from '@/components/filter-table';
import {
  addMonths,
  canApprove,
  canEdit,
  canSubmit,
  isPlanFrozen,
  isPlanWindowOpen,
  monthLabel,
  planComplianceStatus,
  type PlanCompliance,
} from '@/lib/forms/approval';
import { Field, Notice, StatusBadge } from '@/components/forms/form-layout';
import { ApprovalBar } from '@/components/forms/approval-bar';
import { InfoDot } from '@/components/info-dot';
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
  npdBudgetSet = true,
  leadDays = { job: 30, efob: 45, fob: 90 },
  deadlineDay = 7,
  firstActionAt = null,
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
  /** Whether Sourcing has set the monthly NPD cap shown above this plan. */
  npdBudgetSet?: boolean;
  leadDays?: { job: number; efob: number; fob: number };
  /** Rules Master: day of the plan month by which the plan must be approved. */
  deadlineDay?: number;
  /** First admin decision (approve / reject / rework) on this plan, from the approval log. */
  firstActionAt?: string | null;
  role: SdRole;
}) {
  const status: SdStatus = plan?.status ?? 'draft';
  // Submitted / awaiting approval / approved: values are frozen at submission.
  const planLocked = status === 'submitted' || status === 'pending_l2' || status === 'approved';
  // Month-end freeze (spec item 5): a closed month takes no direct edits; only a plan
  // already sent to rework (an amendment, or approver rework) can be edited and re-approved.
  const frozen = isPlanFrozen(planMonth);
  const editable = canEdit(role, status) && (!frozen || status === 'rework');

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
  const [moreFiltersOpen, setMoreFiltersOpen] = useState(false);
  const [planDetailExpanded, setPlanDetailExpanded] = useState(false);
  const [productPickerOpen, setProductPickerOpen] = useState(false);
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
  const hiddenFilterCount = Number(Boolean(inputFabric)) + Number(Boolean(inputPoType));
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

  function addRows(codes: string[]) {
    const next = [...new Set(codes.map((code) => code.trim().toUpperCase()).filter(Boolean))].filter((code) => !used.has(code));
    if (!next.length) return;
    setRows((current) => [...current, ...next.map((code, index) => blankDraft(code, `drawer-${code}-${Date.now()}-${index}`))]);
    setInputFabric('');
    setInputStatus('');
    setInputPoType('');
    setInputSearch('');
    setMessage(`Added ${next.length} product${next.length === 1 ? '' : 's'} to the plan.`);
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
  const inputReviewCount = attention.missingCost + (npdBudgetSet ? 0 : 1);
  const inputReadyCount = planned.filter((item) => !item.missingCost).length;
  const inputSplit = poTypeSplit(view.map((item) => item.row));

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

  // Approval-deadline compliance (spec item 5) and the post-approval amendment request —
  // the sanctioned way to change an approved (or closed) plan: it drops to rework and
  // must be re-approved.
  const compliance = planComplianceStatus(
    plan ? { submitted_at: plan.submitted_at, approved_at: plan.approved_at, action_at: firstActionAt } : null,
    planMonth,
    deadlineDay,
  );
  const [amendOpen, setAmendOpen] = useState(false);
  const [amendNote, setAmendNote] = useState('');
  const canAmend = status === 'approved' && role !== 'viewer' && Boolean(plan?.id);
  function requestAmendment() {
    if (!plan?.id) return;
    setError(null);
    setMessage(null);
    const fd = new FormData();
    fd.set('plan_id', String(plan.id));
    fd.set('note', amendNote);
    start(async () => {
      const r = await requestPlanAmendment(fd);
      if (r.ok) {
        setAmendOpen(false);
        setAmendNote('');
        reloadWithToast(r.message ?? 'Amendment requested.');
      } else setError(r.error);
    });
  }

  const shownCount = mode === 'view' ? viewRows.length : inputRows.length;
  const totalCount = mode === 'view' ? planned.length : view.length;

  // Shared filter toolbar (sticky card). Group-by only applies to the grouped View.
  const toolbar = (
    <div className={`bp-toolbar bp-filter-toolbar bp-filter-toolbar-${mode}`}>
      <input
        className="bp-search"
        aria-label="Search product code"
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
      <select aria-label="Product state" value={inputStatus} onChange={(e) => setInputStatus(e.target.value)}>
        <option value="">State: All</option>
        {statusOptions.map((s) => (
          <option key={s} value={s}>{s}</option>
        ))}
      </select>
      {mode === 'view' && (
        <select aria-label="Group by" value={groupBy} onChange={(e) => setGroupBy(e.target.value as typeof groupBy)}>
          <option value="category">Group by: Category</option>
          <option value="subcategory">Group by: Sub-category</option>
          <option value="weave">Group by: Woven / Knitted</option>
          <option value="code">Group by: Product code</option>
        </select>
      )}
      <button
        type="button"
        className={moreFiltersOpen ? 'bp-more-button active' : 'bp-more-button'}
        aria-expanded={moreFiltersOpen}
        aria-controls="buying-plan-more-filters"
        onClick={() => setMoreFiltersOpen((open) => !open)}
      >
        <MoreHorizontal size={15} aria-hidden="true" />
        More filters
        {hiddenFilterCount > 0 && <span className="bp-more-count">{hiddenFilterCount}</span>}
      </button>
      {mode === 'input' && editable && (
        <button type="button" className="wf-btn wf-btn-primary bp-add-products" onClick={() => setProductPickerOpen(true)}>
          <Plus size={15} aria-hidden="true" />
          Add products
        </button>
      )}
      <span className="bp-toolbar-count">
        {shownCount} of {totalCount} shown
        {hasFilters && (
          <button type="button" className="wf-btn wf-btn-ghost wf-btn-sm" onClick={clearFilters}>
            Clear
          </button>
        )}
      </span>
      <div
        id="buying-plan-more-filters"
        className="bp-more-filters"
        role="group"
        aria-label="More filters"
        hidden={!moreFiltersOpen}
      >
        <select aria-label="Woven or knitted" value={inputFabric} onChange={(e) => setInputFabric(e.target.value)}>
          <option value="">Woven / Knitted: All</option>
          {fabricOptions.map((f) => (
            <option key={f} value={f}>{f}</option>
          ))}
        </select>
        <select aria-label="PO type" value={inputPoType} onChange={(e) => setInputPoType(e.target.value)}>
          <option value="">PO type: All</option>
          <option value="job">Job Work</option>
          <option value="fob">FOB</option>
          <option value="efob">E-FOB</option>
        </select>
      </div>
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
          <ComplianceChip c={compliance} frozen={frozen} />
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

            </>
          )}
          {canAmend && (
            <button type="button" className="wf-btn wf-btn-ghost" onClick={() => setAmendOpen((o) => !o)}>
              Request amendment
            </button>
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

      {frozen && (
        <Notice tone={status === 'rework' ? 'warn' : 'info'}>
          <strong>{monthLabel(planMonth)} is closed.</strong> The plan froze at month-end: no direct edits and no POs can be linked to it. {status === 'rework' ? 'It is open for an approved amendment — make the change and resubmit for approval.' : status === 'approved' ? 'A missed product can still be added through Request amendment; the change must be approved again.' : 'It cannot be edited any more.'}
        </Notice>
      )}

      {amendOpen && canAmend && (
        <div className="bp-card bp-cardbody" style={{ marginBottom: 14 }}>
          <div style={{ fontWeight: 650, marginBottom: 6 }}>
            Request an amendment to the approved plan
            <InfoDot text="Reopens an approved plan as rework. The requested changes must be saved, resubmitted, and approved again." />
          </div>
          <p className="wf-subtle" style={{ margin: '0 0 8px', fontSize: 12 }}>
            For the case where something dropped out of view (a product never got its PO). The plan goes back to rework, you make the change, and it must be approved again — this counts against first-time approval.
          </p>
          <textarea
            value={amendNote}
            onChange={(e) => setAmendNote(e.target.value)}
            placeholder="What needs to change and why — e.g. Maroon fabric line was missed; add 1,200 pcs FOB."
            rows={3}
            style={{
              width: '100%',
              font: 'inherit',
              fontSize: 13,
              padding: 8,
              borderRadius: 8,
              border: '1px solid var(--line-strong, #c9c2ae)',
            }}
          />
          <div style={{ display: 'flex', gap: 8, marginTop: 8 }}>
            <button type="button" className="wf-btn wf-btn-primary wf-btn-sm" disabled={pending || !amendNote.trim()} onClick={requestAmendment}>
              {pending ? 'Sending…' : 'Open for amendment'}
            </button>
            <button type="button" className="wf-btn wf-btn-ghost wf-btn-sm" onClick={() => setAmendOpen(false)}>
              Cancel
            </button>
          </div>
        </div>
      )}

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

            <section id="buying-plan-detail" className={`bp-card bp-plan-detail${planDetailExpanded ? ' is-expanded' : ''}`}>
              <div className="bp-cardhead">
                <h2>
                  Plan detail
                  <InfoDot text="Every finished-goods plan line for the selected month. Search, sort, filter columns, download, or expand the table without changing plan data." />
                </h2>
                <div className="bp-plan-detail-head-actions">
                  <span className="wf-subtle">{view.length} products · every line as on the sheet · filter or sort any column</span>
                  <button
                    type="button"
                    className="wf-btn wf-btn-ghost wf-btn-sm bp-plan-detail-toggle"
                    aria-controls="buying-plan-detail"
                    aria-expanded={planDetailExpanded}
                    onClick={() => setPlanDetailExpanded((expanded) => !expanded)}
                  >
                    {planDetailExpanded ? <Minimize2 size={14} aria-hidden="true" /> : <Maximize2 size={14} aria-hidden="true" />}
                    {planDetailExpanded ? 'Restore' : 'Expand'}
                  </button>
                </div>
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
          <div className="bp-metrics bp-input-metrics" aria-label="Plan input summary">
            <div className="bp-metric">
              <div className="label">Lines in plan</div>
              <div className="value">{fmt.format(planned.length)}</div>
              <div className="sub">{fmt.format(view.length)} products on sheet</div>
            </div>
            <div className="bp-metric">
              <div className="label">Plan quantity</div>
              <div className="value">{fmt.format(totals.qty)}</div>
              <div className="sub">pieces across JOB, E-FOB and FOB</div>
            </div>
            <div className="bp-metric">
              <div className="label">Plan value</div>
              <div className="value">{totals.value ? inr(totals.value) : '—'}</div>
              <div className="sub">{attention.missingCost ? `${attention.missingCost} line${attention.missingCost === 1 ? '' : 's'} missing approved cost` : 'All planned lines have an approved cost'}</div>
            </div>
            <div className="bp-metric">
              <div className="label">Review</div>
              <div className="value">{fmt.format(inputReviewCount)}</div>
              <div className="sub">{inputReviewCount ? 'Review before submit' : 'No plan-level issues found'}</div>
            </div>
          </div>

          <div className="bp-sticky">
            <div className="bp-card bp-toolbar-card">{toolbar}</div>
          </div>
          <div className="bp-stack bp-input-workspace">
            <section className="bp-card">
              <div className="bp-cardhead">
                <div>
                  <h2>
                    Fill the plan
                    <InfoDot text="Enter finished-goods quantities by PO type. Totals, values, and validation update from the existing plan inputs." />
                  </h2>
                  <span className="wf-subtle">Enter quantities by PO type. Zero quantities stay out of the submitted plan.</span>
                </div>
                <Badge tone={status === 'draft' ? 'gray' : status === 'approved' ? 'green' : 'yellow'}>{status.replace('_', ' ')}</Badge>
              </div>
              <div className="bp-cardbody bp-cardbody-flush">
                <div className="table-panel wf-grid-panel bp-input-panel">
                  <div className="table-scroll">
                    <table className="wide-table wf-grid">
                      <thead>
                        <tr>
                          <th>Product code</th>
                          <th>Category</th>
                          <th>Product State</th>
                          <th>Woven / Knitted</th>
                          <th className="num wf-cell-calc">Pending qty</th>
                          <th className="num input-col wf-cell-input">Job work qty</th>
                          <th className="num input-col wf-cell-input">E-FOB qty</th>
                          <th className="num input-col wf-cell-input">FOB qty</th>
                          <th className="num wf-cell-calc">Total quantity</th>
                          <th className="num wf-cell-calc">
                            Standard cost
                            <small className="wf-subtle">Job · E-FOB · FOB</small>
                          </th>
                          <th className="num wf-cell-calc">Value to be bought</th>
                          <th className="num wf-cell-calc">Actual issued quantity</th>
                          <th className="num wf-cell-calc">Actual issued value</th>
                          <th className="input-col wf-cell-input">Remark</th>
                          <th>Validation</th>
                          {editable && <th aria-label="Remove" />}
                        </tr>
                      </thead>
                      <tbody>
                        {inputRows.map(({ row, totalQty, cost, missingCost, valueToBeBought, pending, productStatus, fabricType, category, actualQty, actualValue, overPlan }) => (
                          <tr key={row.key} className={overPlan ? 'wf-row-over' : ''}>
                            <td className="mono">{row.product_code}</td>
                            <td>{category}</td>
                            <td>{productStatus}</td>
                            <td>{fabricType}</td>
                            <td className="num wf-cell-calc">{pending != null ? fmt.format(pending) : '—'}</td>
                            {(['job_work_qty', 'efob_qty', 'fob_qty'] as const).map((field) => (
                              <td key={field} className="num input-col wf-cell-input">
                                <input type="number" min={0} value={row[field]} disabled={!editable} onChange={(event) => patch(row.key, field, event.target.value)} />
                              </td>
                            ))}
                            <td className="num strong wf-cell-calc">{fmt.format(totalQty)}</td>
                            <td className="num wf-cell-calc">
                              {cost ? (
                                <div className="wf-cost-triple">
                                  <span>
                                    <b>Job</b> {fmt.format(cost.job)}
                                  </span>
                                  <span>
                                    <b>E-FOB</b> {fmt.format(cost.efob)}
                                  </span>
                                  <span>
                                    <b>FOB</b> {fmt.format(cost.fob)}
                                  </span>
                                </div>
                              ) : (
                                '—'
                              )}
                            </td>
                            <td className="num wf-cell-calc">{missingCost ? <span className="wf-over-tag">no approved cost</span> : money.format(valueToBeBought)}</td>
                            <td className="num wf-cell-calc">
                              {fmt.format(actualQty)}
                              {overPlan && <span className="wf-over-tag">over plan</span>}
                            </td>
                            <td className="num wf-cell-calc">{money.format(actualValue)}</td>
                            <td className="input-col">
                              <input value={row.remark} disabled={!editable} placeholder="optional" onChange={(event) => patch(row.key, 'remark', event.target.value)} />
                            </td>
                            <td>{missingCost ? <Badge tone="red">No approved cost</Badge> : overPlan ? <Badge tone="red">Over plan</Badge> : totalQty > 0 ? <Badge tone="green">Ready</Badge> : <Badge tone="gray">No qty</Badge>}</td>
                            {editable && (
                              <td>
                                <button type="button" className="wf-icon-btn" aria-label={`Remove ${row.product_code}`} onClick={() => setRows((current) => current.filter((item) => item.key !== row.key))}>
                                  <Trash2 size={14} />
                                </button>
                              </td>
                            )}
                          </tr>
                        ))}
                        {!inputRows.length && (
                          <tr>
                            <td colSpan={editable ? 16 : 15} className="wf-empty-cell">
                              {view.length ? 'No products match the filters.' : 'No product codes added yet. Discontinued variants are excluded automatically.'}
                            </td>
                          </tr>
                        )}
                      </tbody>
                      {view.length > 0 && (
                        <tfoot>
                          <tr>
                            <td colSpan={8}>Total</td>
                            <td className="num strong">{fmt.format(totals.qty)}</td>
                            <td />
                            <td className="num strong">{money.format(totals.value)}</td>
                            <td className="num strong">{fmt.format(totals.actualQty)}</td>
                            <td className="num strong">{money.format(totals.actualValue)}</td>
                            <td />
                            <td />
                            {editable && <td />}
                          </tr>
                        </tfoot>
                      )}
                    </table>
                  </div>
                </div>
              </div>
              <div className="bp-input-footer">
                <div>
                  <strong>
                    {fmt.format(totals.qty)} pcs · {totals.value ? inr(totals.value) : 'value pending'}
                  </strong>
                  <span>
                    {planned.length} planned line
                    {planned.length === 1 ? '' : 's'}
                  </span>
                </div>
                <div className="bp-actions">
                  {editable && (
                    <button type="button" className="wf-btn wf-btn-ghost" onClick={save} disabled={pending}>
                      <Save size={15} /> {pending ? 'Saving…' : 'Save draft'}
                    </button>
                  )}
                  {canSubmit(role, status) && (
                    <button type="button" className="wf-btn wf-btn-primary" onClick={submit} disabled={pending || !plan?.id} title={!plan?.id ? 'Save the plan first' : undefined}>
                      <Send size={15} /> Submit for approval
                    </button>
                  )}
                </div>
              </div>
            </section>

            <aside className="bp-input-support-grid" aria-label="Plan review and lead-time summary">
              <InputValidationCard missingCost={attention.missingCost} npdBudgetSet={npdBudgetSet} ready={inputReadyCount} planned={planned.length} />
              <PlanSplitCard split={inputSplit} leadDays={leadDays} />
              <LeadTimesCard buckets={buckets} isAdmin={role === 'admin'} />
            </aside>
          </div>

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
      {productPickerOpen && <BuyingPlanProductDrawer items={restrictPicker ? pickerItems : catalog} exclude={used} allowFreeText={!restrictPicker} onAdd={addRows} onAddAll={addAll} canAddAll={available.length > 0} onClose={() => setProductPickerOpen(false)} />}
    </>
  );
}

function BuyingPlanProductDrawer({ items, exclude, allowFreeText, onAdd, onAddAll, canAddAll, onClose }: { items: ProductCatalogItem[]; exclude: Set<string>; allowFreeText: boolean; onAdd: (codes: string[]) => void; onAddAll: () => void; canAddAll: boolean; onClose: () => void }) {
  const [query, setQuery] = useState('');
  const [selected, setSelected] = useState<Set<string>>(() => new Set());
  const excludeUpper = useMemo(() => new Set([...exclude].map((code) => code.toUpperCase())), [exclude]);
  const availableItems = useMemo(() => items.filter((item) => !excludeUpper.has(item.product_code.toUpperCase())), [excludeUpper, items]);
  const queryLower = query.trim().toLowerCase();
  const filteredItems = useMemo(
    () => availableItems.filter((item) => !queryLower || item.product_code.toLowerCase().includes(queryLower) || (item.product_name ?? '').toLowerCase().includes(queryLower) || (item.category ?? '').toLowerCase().includes(queryLower)),
    [availableItems, queryLower],
  );

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [onClose]);

  function toggle(code: string) {
    setSelected((current) => {
      const next = new Set(current);
      if (next.has(code)) next.delete(code);
      else next.add(code);
      return next;
    });
  }

  function addSelected() {
    if (!selected.size) return;
    onAdd([...selected]);
    onClose();
  }

  return (
    <div className="bp-drawer-scrim" onMouseDown={(event) => event.target === event.currentTarget && onClose()}>
      <aside className="bp-product-drawer" role="dialog" aria-modal="true" aria-labelledby="bp-product-drawer-title">
        <div className="bp-drawer-head">
          <div>
            <h2 id="bp-product-drawer-title">Add products</h2>
            <span>Select one or more products for this month’s plan.</span>
          </div>
          <button type="button" className="wf-icon-btn" onClick={onClose} aria-label="Close product picker">
            <X size={18} />
          </button>
        </div>
        <div className="bp-drawer-body">
          <div className="bp-drawer-quick-add">
            <span className="bp-drawer-label">Quick add</span>
            <ProductPicker
              items={items}
              exclude={exclude}
              allowFreeText={allowFreeText}
              onPick={(code) => {
                onAdd([code]);
                onClose();
              }}
              placeholder={allowFreeText ? 'Search code or product name…' : 'Search approved-cost products…'}
            />
          </div>
          <label className="bp-drawer-search">
            <Search size={16} aria-hidden="true" />
            <input autoFocus value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Filter available products" />
          </label>
          <div className="bp-drawer-list" role="list" aria-label="Available products">
            {filteredItems.map((item) => (
              <label className="bp-drawer-item" key={item.product_code}>
                <input type="checkbox" checked={selected.has(item.product_code)} onChange={() => toggle(item.product_code)} />
                <span>
                  <strong className="mono">{item.product_code}</strong>
                  <small>{item.product_name ?? 'Unnamed product'}</small>
                </span>
                <em>{item.category ?? 'Uncategorised'}</em>
              </label>
            ))}
            {!filteredItems.length && <div className="bp-drawer-empty">{availableItems.length ? 'No products match this search.' : 'Every available product is already on the plan.'}</div>}
          </div>
        </div>
        <div className="bp-drawer-footer">
          <button
            type="button"
            className="wf-btn wf-btn-ghost"
            disabled={!canAddAll}
            onClick={() => {
              onAddAll();
              onClose();
            }}
          >
            Add all available
          </button>
          <div className="bp-actions">
            <button type="button" className="wf-btn wf-btn-ghost" onClick={onClose}>
              Cancel
            </button>
            <button type="button" className="wf-btn wf-btn-primary" disabled={!selected.size} onClick={addSelected}>
              Add {selected.size || ''} product{selected.size === 1 ? '' : 's'}
            </button>
          </div>
        </div>
      </aside>
    </div>
  );
}

function InputValidationCard({ missingCost, npdBudgetSet, ready, planned }: { missingCost: number; npdBudgetSet: boolean; ready: number; planned: number }) {
  const reviewCount = missingCost + (npdBudgetSet ? 0 : 1);
  return (
    <section className="bp-card">
      <div className="bp-cardhead">
        <h2>
          Review before submit
          <InfoDot text="Highlights missing approved costs and monthly NPD-budget setup that require review before the plan is submitted." />
        </h2>
        <Badge tone={reviewCount ? 'yellow' : 'green'}>{reviewCount ? `${reviewCount} to review` : 'All clear'}</Badge>
      </div>
      <div className="bp-cardbody bp-attention">
        {missingCost > 0 && (
          <div className="bp-issue">
            <div className="left">
              <span className="bp-dot red" />
              <div>
                <b>Missing approved cost</b>
                <span>Plan value cannot be calculated for these lines</span>
              </div>
            </div>
            <strong>{missingCost}</strong>
          </div>
        )}
        {!npdBudgetSet && (
          <div className="bp-issue">
            <div className="left">
              <span className="bp-dot yellow" />
              <div>
                <b>NPD budget not set</b>
                <span>Monthly planning reference is not configured</span>
              </div>
            </div>
            <strong>1</strong>
          </div>
        )}
        {!reviewCount && <span className="wf-subtle">Nothing is flagged at plan level.</span>}
        <div className="bp-validation-ready">
          <span>Lines ready</span>
          <strong>
            {ready} / {planned}
          </strong>
        </div>
      </div>
    </section>
  );
}

function PlanSplitCard({ split, leadDays }: { split: { job: number; fob: number; efob: number }; leadDays: { job: number; efob: number; fob: number } }) {
  const rows = [
    { key: 'job', label: 'JOB', qty: split.job, days: leadDays.job },
    { key: 'efob', label: 'E-FOB', qty: split.efob, days: leadDays.efob },
    { key: 'fob', label: 'FOB', qty: split.fob, days: leadDays.fob },
  ];
  return (
    <section className="bp-card">
      <div className="bp-cardhead">
        <h2>
          Plan split
          <InfoDot text="Summarises planned quantity by Job Work, E-FOB, and FOB, together with the lead-time rule for each route." />
        </h2>
        <span className="wf-subtle">quantity by PO type</span>
      </div>
      <div className="bp-cardbody">
        {rows.map((row) => (
          <div className="bp-summaryrow" key={row.key}>
            <span>
              {row.label}
              <small className="bp-summary-sub">{row.days} day lead time</small>
            </span>
            <b>{fmt.format(row.qty)} pcs</b>
          </div>
        ))}
        <div className="bp-summaryrow">
          <span>Total</span>
          <b>{fmt.format(split.job + split.efob + split.fob)} pcs</b>
        </div>
      </div>
    </section>
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

/** Approve-by chip: on time / pending / breach (with which side was late). */
function ComplianceChip({ c, frozen }: { c: PlanCompliance; frozen: boolean }) {
  const dl = new Date(c.deadline).toLocaleDateString('en-IN', {
    day: 'numeric',
    month: 'short',
    timeZone: 'Asia/Kolkata',
  });
  const spec: Record<PlanCompliance['status'], { tone: 'green' | 'yellow' | 'red' | 'gray'; text: string; title: string }> = {
    on_time: {
      tone: 'green',
      text: 'Approved on time',
      title: `Approved by the ${dl} deadline`,
    },
    pending: {
      tone: 'yellow',
      text: `Approve by ${dl}`,
      title: 'Plan must be approved by this date',
    },
    breach_submission: {
      tone: 'red',
      text: `Breach · submission side · ${c.daysLate}d late`,
      title: `Not submitted by the ${dl} deadline`,
    },
    breach_approval: {
      tone: 'red',
      text: `Breach · approval side · ${c.daysLate}d late`,
      title: `Submitted in time but not approved by ${dl}`,
    },
  };
  const s = spec[c.status];
  return (
    <span style={{ display: 'inline-flex', gap: 6, alignItems: 'center' }}>
      <span className={`bp-badge ${s.tone}`} title={s.title}>
        {s.text}
      </span>
      {frozen && (
        <span className="bp-badge gray" title="Month ended — plan is frozen">
          Closed
        </span>
      )}
    </span>
  );
}

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
        <h2>
          Plan overview
          <InfoDot text="Summarises the selected month's finished-goods plan: issued versus planned quantity, total plan value, 30-day demand projection, and issued value." />
        </h2>
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
        <h2>
          Needs attention
          <InfoDot text="Counts plan lines requiring review: missing approved cost, approval pending, issued above plan, or planned with nothing issued." />
        </h2>
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
        <h2>
          PO lead times
          <InfoDot text="Uses Rules Master lead-time days and the 30-day ROP demand to show the quantity needed to cover each PO route." />
        </h2>
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
        <h2>
          Planned value by PO type
          <InfoDot text="Splits planned quantity and value across Job Work, FOB, and E-FOB using the approved standard cost for each line." />
        </h2>
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
        <h2>
          Buying plan by {GROUP_LABEL[groupBy]}
          <InfoDot text="Groups planned products by the selected Group By dimension. Quantities and values follow the active filters above." />
        </h2>
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
