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
  category: string | null;
  stock: number;
  dailyDemand: number;
  oosDays45: number;
  oosDays365: number;
};

export type OosScope = {
  scope: string;
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

export type OosSummary = { all: OosScope; categories: OosScope[] };

export const OOS_WINDOW_45 = 45;
export const OOS_WINDOW_365 = 365;

/** Which product states can be out of stock: on sale now. Same rule as the dashboard card. */
export function isSellingState(raw: string | null | undefined): boolean {
  const v = (raw ?? '').trim().toUpperCase();
  if (v === 'ONGOING') return true;
  return v.startsWith('NPD') && !v.includes('NOT LAUNCH');
}

/** "SHIRT" / "Shirt" / " shirt " are one category. */
export function normaliseCategory(raw: string | null | undefined): string {
  const v = (raw ?? '').trim().replace(/\s+/g, ' ');
  if (!v) return 'Uncategorised';
  return v.toLowerCase().replace(/(^|\s)\S/g, (c) => c.toUpperCase());
}

function scopeOf(scope: string, rows: OosSkuInput[]): OosScope {
  const skus = rows.length;
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
  return { all: scopeOf('all', rows), categories };
}
