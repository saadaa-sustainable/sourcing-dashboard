/**
 * Out-of-stock one-pager — the pure arithmetic. Plain module, no I/O, unit-tested.
 *
 * Two different OOS measures, both kept, because they answer different questions:
 *   • OOS in the window (45 / 365 days): a SKU counts if it was empty on ANY day. This is
 *     the sourcing team's efficiency record — it does not improve until the window rolls.
 *   • OOS yesterday: the position as of the latest nightly snapshot. This is the trend —
 *     when the team brings 50 empty SKUs down to 30, this is where it shows.
 *
 * The percentages are all "share of SKU-days empty" so they compare like with like: over
 * a 1-day window that is simply empty SKUs ÷ SKUs, over 45 days it is Σ empty days ÷
 * (SKUs × 45). "Change" is yesterday against the 45-day figure on that shared basis.
 */

export type OosSkuInput = {
  sku: string;
  /** The product code — what the product master calls the category (SDFLK, SMFSK…). */
  category: string | null;
  /** Product name, colour (variant) and size, for the SKU list under a category. */
  name?: string | null;
  variant?: string | null;
  size?: string | null;
  stock: number;
  dailyDemand: number;
  oosDays45: number;
  oosDays365: number;
};

/** One SKU as listed under its category: where it stands today. */
export type OosSkuRow = {
  sku: string;
  variant: string;
  size: string;
  name: string;
  stock: number;
  dailyDemand: number;
  oosDays45: number;
  oosDays365: number;
  /** empty = no stock yesterday · recovered = was empty in 45 days, stocked now · ok = never empty in 45 days. */
  state: 'empty' | 'recovered' | 'ok';
};

export type OosScope = {
  scope: string;
  /** Product name for a category scope (the code is the scope itself); '' for 'all'. */
  label: string;
  skus: number;
  /** SKUs with no stock as of the snapshot day. */
  oosYesterday: number;
  /** SKUs empty on at least one day of the window. */
  oos45: number;
  oos365: number;
  /** Empty SKU-days in the window ("perishable": every day counts once). */
  oosDays45: number;
  oosDays365: number;
  /** Empty at some point in the 45 days and stocked on the snapshot day. */
  recovered45: number;
  /** Share of SKU-days empty: yesterday (= SKU share), 45-day, 365-day. 0–1. */
  pctYesterday: number;
  pct45: number;
  pct365: number;
  /** (pctYesterday − pct45) ÷ pct45; null when there was nothing to fall from. */
  changeVs45: number | null;
  /** Days the stock lasts at the current sales rate, over SKUs that sell; null if none do. */
  daysOnHand: number | null;
};

export type OosSummary = {
  all: OosScope;
  categories: OosScope[];
  /** The SKUs behind each category, keyed by scope; empty ones first, then by days empty. */
  skusByScope: Record<string, OosSkuRow[]>;
};

export const OOS_WINDOW_45 = 45;
export const OOS_WINDOW_365 = 365;

/** Which product states can be out of stock: on sale now. Same rule as the dashboard card. */
export function isSellingState(raw: string | null | undefined): boolean {
  const v = (raw ?? '').trim().toUpperCase();
  if (v === 'ONGOING') return true;
  return v.startsWith('NPD') && !v.includes('NOT LAUNCH');
}

/** The category is the product code as the master holds it: upper-cased, trimmed. */
export function normaliseCategory(raw: string | null | undefined): string {
  const v = (raw ?? '').trim().toUpperCase();
  return v || 'UNCATEGORISED';
}

const stateOf = (r: OosSkuInput): OosSkuRow['state'] =>
  r.stock <= 0 ? 'empty' : r.oosDays45 > 0 ? 'recovered' : 'ok';

const STATE_RANK: Record<OosSkuRow['state'], number> = { empty: 0, recovered: 1, ok: 2 };

function scopeOf(scope: string, rows: OosSkuInput[]): OosScope {
  const skus = rows.length;
  // The product name most of the rows carry — one code is one product, so any row will do,
  // but the commonest guards against a stray blank.
  const names = new Map<string, number>();
  for (const r of rows) {
    const n = (r.name ?? '').trim();
    if (n) names.set(n, (names.get(n) ?? 0) + 1);
  }
  const label = scope === 'all' ? '' : [...names.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] ?? '';
  let oosYesterday = 0, oos45 = 0, oos365 = 0, oosDays45 = 0, oosDays365 = 0, recovered45 = 0;
  let stockSelling = 0, demand = 0;
  for (const r of rows) {
    const empty = r.stock <= 0;
    const d45 = Math.max(0, r.oosDays45);
    const d365 = Math.max(0, r.oosDays365);
    if (empty) oosYesterday += 1;
    if (d45 > 0) oos45 += 1;
    if (d365 > 0) oos365 += 1;
    if (d45 > 0 && !empty) recovered45 += 1;
    oosDays45 += d45;
    oosDays365 += d365;
    if (r.dailyDemand > 0) {
      stockSelling += Math.max(0, r.stock);
      demand += r.dailyDemand;
    }
  }
  const pctYesterday = skus ? oosYesterday / skus : 0;
  const pct45 = skus ? oosDays45 / (skus * OOS_WINDOW_45) : 0;
  const pct365 = skus ? oosDays365 / (skus * OOS_WINDOW_365) : 0;
  return {
    scope,
    label,
    skus,
    oosYesterday,
    oos45,
    oos365,
    oosDays45,
    oosDays365,
    recovered45,
    pctYesterday,
    pct45,
    pct365,
    changeVs45: pct45 > 0 ? (pctYesterday - pct45) / pct45 : null,
    daysOnHand: demand > 0 ? stockSelling / demand : null,
  };
}

/** Overall plus one scope per category, categories with the worst yesterday first. */
export function summariseOos(rows: OosSkuInput[]): OosSummary {
  const byCat = new Map<string, OosSkuInput[]>();
  for (const r of rows) {
    const c = normaliseCategory(r.category);
    const list = byCat.get(c);
    if (list) list.push(r);
    else byCat.set(c, [r]);
  }
  const categories = [...byCat.entries()]
    .map(([c, list]) => scopeOf(c, list))
    .sort((a, b) => b.pctYesterday - a.pctYesterday || b.pct45 - a.pct45 || a.scope.localeCompare(b.scope));
  const skusByScope: Record<string, OosSkuRow[]> = {};
  for (const [c, list] of byCat) {
    skusByScope[c] = list
      .map((r) => ({
        sku: r.sku,
        variant: (r.variant ?? '').trim(),
        size: (r.size ?? '').trim(),
        name: (r.name ?? '').trim(),
        stock: r.stock,
        dailyDemand: r.dailyDemand,
        oosDays45: Math.max(0, r.oosDays45),
        oosDays365: Math.max(0, r.oosDays365),
        state: stateOf(r),
      }))
      .sort(
        (a, b) =>
          STATE_RANK[a.state] - STATE_RANK[b.state] ||
          b.oosDays45 - a.oosDays45 ||
          b.dailyDemand - a.dailyDemand ||
          a.sku.localeCompare(b.sku),
      );
  }
  return { all: scopeOf('all', rows), categories, skusByScope };
}
