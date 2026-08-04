/**
 * Discontinued-inventory ageing + liquidation logic.
 *
 * Pure functions over the `discontinued_inventory` mirror table (one row per
 * physical unit / serial). The dashboard rolls units up to SKU level and, from
 * the qty + ageing + sales, derives an ageing bucket, a suggested discount and a
 * recommended action — the rules ops defined in the sheet's Requirements_actions
 * tab. No I/O here so it stays unit-testable (mirrors lib/business-logic.ts).
 *
 * Ageing uses the sheet's `days_in_warehouse` as-is (not recomputed). A SKU's
 * ageing for the ">365 day" action triggers is its OLDEST available unit.
 */

export type DiscontinuedInventoryRow = {
  source_row_key: string;
  sku: string | null;
  category: string | null;
  sub_category: string | null;
  product_name: string | null;
  color: string | null;
  size: string | null;
  mrp: number | null;
  cost: number | null;
  product_launch_date: string | null;
  product_state: string | null;
  available_inventory: number | null;
  inventory_status: string | null;
  status: string | null;
  serial_number: string | null;
  inward_date: string | null;
  days_in_warehouse: number | null;
};

export type AgeingBucket = 'New' | 'Aging' | 'Old' | 'Dead Stock';

export type RecommendedAction =
  | 'Sell through naturally'
  | 'Transfer to high-selling store'
  | 'Run discount campaign'
  | 'Bulk liquidation / B2B sale'
  | 'Write-off review';

export type SkuRollup = {
  sku: string;
  productVariant: string;
  productCode: string;
  productName: string | null;
  category: string | null;
  subCategory: string | null;
  color: string | null;
  size: string | null;
  mrp: number;
  cost: number;
  qty: number; // available units in the warehouse
  oldestDays: number; // ageing of the oldest available unit
  bucket: AgeingBucket; // SKU-level bucket (by oldest unit) — drives the action
  unitsByBucket: Record<AgeingBucket, number>; // each unit by its OWN age (ageing view)
  suggestedDiscount: string; // e.g. '10%', '40–60%', '—'
  sales45d: number | null; // from sd_variant_sales (variant grain), null if unmapped
  action: RecommendedAction;
  valueAtCost: number; // qty * cost
  valueAtMrp: number; // qty * mrp
};

const num = (value: number | null | undefined) =>
  Number.isFinite(value) ? Number(value) : 0;

const text = (value: string | null | undefined) => (value ?? '').trim();

/**
 * SKU -> (product_variant, product_code). Same convention as backfill-po.mjs
 * derive(): variant is everything before the final `_<size>`; the product code
 * drops the 2-char colour suffix. e.g. `SDALPNB_4XL` -> variant `SDALPNB`,
 * code `SDALP`. Used to join variant-level sales (sd_variant_sales).
 */
export function deriveVariant(sku: string | null | undefined): {
  productVariant: string;
  productCode: string;
} {
  const s = text(sku);
  const match = s.match(/^(.*)_([^_]+)$/);
  const productVariant = match ? match[1] : s;
  const productCode =
    productVariant.length > 2 ? productVariant.slice(0, -2) : productVariant;
  return { productVariant, productCode };
}

/** Ageing bucket from days in warehouse. */
export function ageingBucket(days: number): AgeingBucket {
  if (days < 90) return 'New';
  if (days <= 180) return 'Aging';
  if (days <= 365) return 'Old';
  return 'Dead Stock';
}

/**
 * Suggested discount from days in warehouse. Finer bands than the ageing bucket
 * (the "Old" bucket splits at 270). New stock (<90d) gets no suggested discount.
 */
export function suggestedDiscount(days: number): string {
  if (days < 90) return '—';
  if (days <= 180) return '10%';
  if (days <= 270) return '20%';
  if (days <= 365) return '30%';
  return '40–60%';
}

/**
 * Recommended action, applied in priority order (most severe first) so the two
 * ">365 day" overrides and the no-sales write-off win over the plain qty bands:
 *   1. no sales & >365d          -> Write-off review
 *   2. qty >200 & >365d          -> Bulk liquidation / B2B sale
 *   3. qty >50                   -> Run discount campaign
 *   4. qty 10–50                 -> Transfer to high-selling store
 *   5. qty <10                   -> Sell through naturally
 * `sales45d` is the variant's 45-day sales; null (unmapped) is NOT treated as
 * "no sales" — the write-off rule needs a real zero.
 */
export function recommendedAction(input: {
  qty: number;
  oldestDays: number;
  sales45d: number | null;
}): RecommendedAction {
  const { qty, oldestDays, sales45d } = input;
  if (sales45d === 0 && oldestDays > 365) return 'Write-off review';
  if (qty > 200 && oldestDays > 365) return 'Bulk liquidation / B2B sale';
  if (qty > 50) return 'Run discount campaign';
  if (qty >= 10) return 'Transfer to high-selling store';
  return 'Sell through naturally';
}

/** A unit counts as available warehouse stock. */
export function isAvailableUnit(row: DiscontinuedInventoryRow): boolean {
  return (
    text(row.inventory_status).toLowerCase() === 'inventory available' &&
    num(row.available_inventory) > 0
  );
}

/**
 * Roll serial-level rows up to one row per SKU (colour + size), keeping only
 * available units. `salesByVariant` maps product_variant -> 45-day sales.
 */
export function rollupBySku(
  rows: DiscontinuedInventoryRow[],
  salesByVariant: Map<string, number> = new Map(),
): SkuRollup[] {
  const groups = new Map<string, DiscontinuedInventoryRow[]>();
  for (const row of rows) {
    if (!isAvailableUnit(row)) continue;
    const sku = text(row.sku);
    if (!sku) continue;
    const bucket = groups.get(sku);
    if (bucket) bucket.push(row);
    else groups.set(sku, [row]);
  }

  const rollups: SkuRollup[] = [];
  for (const [sku, units] of groups) {
    const first = units[0];
    const { productVariant, productCode } = deriveVariant(sku);
    const qty = units.reduce((sum, u) => sum + num(u.available_inventory), 0);
    const oldestDays = units.reduce(
      (max, u) => Math.max(max, num(u.days_in_warehouse)),
      0,
    );
    // Each physical unit bucketed by its OWN age — the true ageing distribution.
    const unitsByBucket: Record<AgeingBucket, number> = { New: 0, Aging: 0, Old: 0, 'Dead Stock': 0 };
    for (const u of units) unitsByBucket[ageingBucket(num(u.days_in_warehouse))] += num(u.available_inventory);
    const mrp = num(first.mrp);
    const cost = num(first.cost);
    const sales45d = salesByVariant.has(productVariant)
      ? num(salesByVariant.get(productVariant))
      : null;
    rollups.push({
      sku,
      productVariant,
      productCode,
      productName: first.product_name,
      category: first.category,
      subCategory: first.sub_category,
      color: first.color,
      size: first.size,
      mrp,
      cost,
      qty,
      oldestDays,
      bucket: ageingBucket(oldestDays),
      unitsByBucket,
      suggestedDiscount: suggestedDiscount(oldestDays),
      sales45d,
      action: recommendedAction({ qty, oldestDays, sales45d }),
      valueAtCost: qty * cost,
      valueAtMrp: qty * mrp,
    });
  }

  // Most units first — the biggest liquidation opportunities on top.
  return rollups.sort((a, b) => b.qty - a.qty);
}

export const AGEING_BUCKETS: AgeingBucket[] = ['New', 'Aging', 'Old', 'Dead Stock'];
export const RECOMMENDED_ACTIONS: RecommendedAction[] = [
  'Sell through naturally',
  'Transfer to high-selling store',
  'Run discount campaign',
  'Bulk liquidation / B2B sale',
  'Write-off review',
];
