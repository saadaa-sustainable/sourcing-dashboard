import type { DoqWindowRow, OosCalculationRow } from '@/lib/forms/types';

/**
 * DOQ Dashboard aggregation — a faithful port of the sheet "DOQ 3-Table
 * Generator" formulas (verified against the script):
 *
 *   window DOQ (per SKU)  = window qty sold / window available days
 *   DOH Stock / In-Process = category AVERAGE of (stock / DOQ)
 *   Sales Leakage          = Σ (window OOS days × 45-day DOQ × selling price)
 *                            (fixed 45d DOQ so OOS items still register)
 *   Total sku days         = category SKU count × N distinct days in window
 *   OOS%                   = OOS days / Total sku days;  In-Stock = 1 − OOS%
 *   % DOQ Contribution     = category DOQ / table total DOQ
 *   TOTAL row DOH          = average across ALL SKUs (not sum of averages)
 *
 * Category = Product State for now (COM STATUS grouping pending a source).
 * SKUs on the OOS exclusion list are left out entirely.
 */

export const DOQ_WINDOW_KEYS = ['d1', 'l7', 'w1', 'w2', 'w3', 'w4', 'at'] as const;
export type DoqWindowKey = (typeof DOQ_WINDOW_KEYS)[number];

export const DOQ_WEAVES = ['All', 'Woven', 'Knit'] as const;
export type DoqWeave = (typeof DOQ_WEAVES)[number];

const STATUS_ORDER = [
  'NPD - Not Launched Yet',
  'NPD',
  'Ongoing',
  'To Be Discontinued',
];

/* ---------------- Product Class (ABC/D) + COM STATUS ---------------- */

export type ClassRules = { aAbove: number; bMin: number; cMin: number };

/** NPD-family states are not ABC-classified — their COM suffix is "NPD". */
export function isNpdFamily(state: string | null): boolean {
  const s = (state ?? '').toLowerCase();
  return s.includes('npd') || s.includes('not launch');
}

/** ABC/D class from the SKU's IPDOQ: >a → A, ≥b → B, ≥c → C, else D. */
export function productClassOf(ipdoq: number, r: ClassRules): 'A' | 'B' | 'C' | 'D' {
  if (ipdoq > r.aAbove) return 'A';
  if (ipdoq >= r.bMin) return 'B';
  if (ipdoq >= r.cMin) return 'C';
  return 'D';
}

/**
 * SKU-level IPDOQ, same rule as sd_replenishment's variant-level column:
 * DOQ-45 unless the 45-day window was mostly OOS (above the threshold), then
 * the higher of DOQ-365 / DOQ-45; floored.
 */
export function computeSkuIpdoq(
  doq45: number,
  doq365: number,
  oos45: number,
  oosThreshold: number,
  floor: number,
): number {
  const raw = oos45 > oosThreshold ? Math.max(doq365, doq45) : doq45;
  return Math.max(floor, raw || 0);
}

/** COM STATUS = "<state>-<class>"; NPD-family gets the literal "-NPD". */
export function comStatusOf(state: string | null, cls: string): string {
  const s = state?.trim() || 'Unknown';
  return `${s}-${isNpdFamily(s) ? 'NPD' : cls}`;
}

/** Sheet ordering for COM rows: base state order first, then class A<B<C<D<NPD. */
export function compareCom(a: string, b: string): number {
  const base = (v: string) => {
    const i = v.lastIndexOf('-');
    return i > 0 ? v.slice(0, i) : v;
  };
  const suffix = (v: string) => {
    const i = v.lastIndexOf('-');
    return i > 0 ? v.slice(i + 1) : '';
  };
  const idx = (v: string) => {
    const i = STATUS_ORDER.indexOf(base(v));
    return i === -1 ? STATUS_ORDER.length : i;
  };
  return (
    idx(a) - idx(b) ||
    base(a).localeCompare(base(b)) ||
    suffix(a).localeCompare(suffix(b))
  );
}

export type DoqCategoryRow = {
  category: string;
  skuCount: number;
  pctSku: number;
  doq: number;
  pctDoq: number;
  dohStock: number;
  dohInProcess: number;
  oosSkuCount: number;
  oosSkuPct: number;
  salesLeakage: number;
  oosDays: number;
  oosPct: number;
  inStockRate: number;
  skuDays: number;
};

type Acc = {
  doq: number;
  oosDays: number;
  oosCount: number;
  dohStockSum: number;
  dohIpSum: number;
  leak: number;
};

function weaveBucket(weave: string | null): DoqWeave | 'Other' {
  const w = (weave ?? '').toLowerCase();
  if (w.includes('woven')) return 'Woven';
  if (w.includes('knit')) return 'Knit';
  return 'Other';
}

/** Aggregate one window × one weave filter into category rows + TOTAL. */
export function aggregateDoqWindow(
  windowRows: Record<string, DoqWindowRow>,
  meta: OosCalculationRow[],
  excluded: Set<string>,
  key: DoqWindowKey,
  weave: DoqWeave,
  ndays: number,
  opts?: {
    /** Category resolver — defaults to Product State. */
    categoryOf?: (m: OosCalculationRow) => string;
    /** 'state' = fixed status order; 'com' = base-state order then class. */
    order?: 'state' | 'com';
  },
): DoqCategoryRow[] {
  const categoryOf = opts?.categoryOf ?? ((m) => m.product_status?.trim() || 'Unknown');
  const N = Math.max(1, ndays);
  const byCat: Record<string, Acc> = {};
  const countMap: Record<string, number> = {};

  for (const m of meta) {
    if (excluded.has(m.sku.toUpperCase())) continue;
    if (weave !== 'All' && weaveBucket(m.weave_type) !== weave) continue;

    const cat = categoryOf(m);
    countMap[cat] = (countMap[cat] ?? 0) + 1;

    const w = windowRows[m.sku];
    const avail = Number(w?.[`${key}_avail`] ?? 0) || 0;
    const oos = Number(w?.[`${key}_oos`] ?? 0) || 0;
    const qty = Number(w?.[`${key}_qty`] ?? 0) || 0;

    const doq = avail > 0 ? qty / avail : 0;
    const dohStock = doq > 0 ? (m.current_stock ?? 0) / doq : 0;
    const dohIp = doq > 0 ? (m.inprocess_stock ?? 0) / doq : 0;
    const leak = oos * (m.doq_45 ?? 0) * (m.sales_value ?? 0);

    const a = (byCat[cat] ??= {
      doq: 0,
      oosDays: 0,
      oosCount: 0,
      dohStockSum: 0,
      dohIpSum: 0,
      leak: 0,
    });
    a.doq += doq;
    a.oosDays += oos;
    if (oos > 0) a.oosCount += 1;
    a.dohStockSum += dohStock;
    a.dohIpSum += dohIp;
    a.leak += leak;
  }

  const cats =
    opts?.order === 'com'
      ? Object.keys(countMap).sort(compareCom)
      : [
          ...STATUS_ORDER.filter((s) => countMap[s] !== undefined),
          ...Object.keys(countMap)
            .filter((c) => !STATUS_ORDER.includes(c))
            .sort(),
        ];

  const totalSku = Object.values(countMap).reduce((s, n) => s + n, 0);
  const tableTotalDoq = cats.reduce((s, c) => s + (byCat[c]?.doq ?? 0), 0);

  const rows: DoqCategoryRow[] = [];
  const tot: Acc & { cnt: number; skuDays: number } = {
    doq: 0, oosDays: 0, oosCount: 0, dohStockSum: 0, dohIpSum: 0, leak: 0,
    cnt: 0, skuDays: 0,
  };

  for (const cat of cats) {
    const cnt = countMap[cat] ?? 0;
    const a = byCat[cat] ?? { doq: 0, oosDays: 0, oosCount: 0, dohStockSum: 0, dohIpSum: 0, leak: 0 };
    const skuDays = cnt * N;
    const oosPct = skuDays > 0 ? a.oosDays / skuDays : 0;
    rows.push({
      category: cat,
      skuCount: cnt,
      pctSku: totalSku > 0 ? cnt / totalSku : 0,
      doq: Math.round(a.doq * 10) / 10,
      pctDoq: tableTotalDoq > 0 ? a.doq / tableTotalDoq : 0,
      dohStock: cnt > 0 ? Math.round(a.dohStockSum / cnt) : 0,
      dohInProcess: cnt > 0 ? Math.round(a.dohIpSum / cnt) : 0,
      oosSkuCount: a.oosCount,
      oosSkuPct: cnt > 0 ? a.oosCount / cnt : 0,
      salesLeakage: Math.round(a.leak),
      oosDays: Math.round(a.oosDays),
      oosPct,
      inStockRate: 1 - oosPct,
      skuDays,
    });
    tot.cnt += cnt;
    tot.doq += a.doq;
    tot.oosDays += a.oosDays;
    tot.oosCount += a.oosCount;
    tot.dohStockSum += a.dohStockSum;
    tot.dohIpSum += a.dohIpSum;
    tot.leak += a.leak;
    tot.skuDays += skuDays;
  }

  const totOosPct = tot.skuDays > 0 ? tot.oosDays / tot.skuDays : 0;
  rows.push({
    category: 'TOTAL',
    skuCount: tot.cnt,
    pctSku: totalSku > 0 ? tot.cnt / totalSku : 0,
    doq: Math.round(tot.doq * 10) / 10,
    pctDoq: tableTotalDoq > 0 ? tot.doq / tableTotalDoq : 0,
    dohStock: tot.cnt > 0 ? Math.round(tot.dohStockSum / tot.cnt) : 0,
    dohInProcess: tot.cnt > 0 ? Math.round(tot.dohIpSum / tot.cnt) : 0,
    oosSkuCount: tot.oosCount,
    oosSkuPct: tot.cnt > 0 ? tot.oosCount / tot.cnt : 0,
    salesLeakage: Math.round(tot.leak),
    oosDays: Math.round(tot.oosDays),
    oosPct: totOosPct,
    inStockRate: 1 - totOosPct,
    skuDays: tot.skuDays,
  });

  return rows;
}
