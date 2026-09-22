import 'server-only';
import { client, pageAll } from './_shared';
import { isSellingState, summariseOos, type OosScope, type OosSkuInput, type OosSummary } from '@/lib/oos-summary';

/**
 * Out-of-stock one-pager data.
 *
 * Source: the nightly inventory-planning snapshot, MAIN WAREHOUSE rows only. That is the
 * warehouse the demand figures belong to (the only one with a daily quantity), and the
 * only one where "days out of stock" means anything: the STORE rows carry an empty-day
 * count for SKUs the store never stocks, which is what once made the whole catalogue
 * read as 98% out of stock. Scope: product states that are on sale (Ongoing + launched
 * NPD), minus the shared test-SKU exclusion list.
 */
export const OOS_SUMMARY_WAREHOUSE = 'Main Warehouse';

export type OosSummaryData = OosSummary & {
  /** The data day (sd_inventory_planning.date_day) — "yesterday" in the team's words. */
  asOf: string | null;
  warehouse: string;
  excludedSkus: number;
  /** Product codes on the feed that are NOT in the table, by the product state that keeps them out. */
  codesLeftOut: { state: string; codes: number }[];
};

export async function loadOosSummary(): Promise<OosSummaryData | null> {
  try {
    const supabase = await client();
    const norm = (s: string | null | undefined) => (s ?? '').trim().toUpperCase();
    const { data: excluded } = await supabase.from('sd_oos_sku_exclusion').select('sku');
    const excludedSkus = new Set(
      ((excluded ?? []) as { sku: string | null }[]).map((r) => norm(r.sku)).filter(Boolean),
    );

    // `category` on the feed is the product code (SDFLK…), which is exactly what the product
    // master calls the category — so the rows here group the way the master does.
    type Row = {
      sku: string | null; category: string | null; product_name: string | null; product_variant: string | null; size: string | null;
      product_state: string | null; date_day: string | null;
      current_stock: number | null; daily_quantity: number | null; oos_days_45: number | null; oos_days_365: number | null;
    };
    const rows = await pageAll<Row>(() =>
      supabase
        .from('sd_inventory_planning')
        .select('sku, category, product_name, product_variant, size, product_state, date_day, current_stock, daily_quantity, oos_days_45, oos_days_365')
        .eq('warehouse', OOS_SUMMARY_WAREHOUSE)
        .order('sku'),
    );

    let asOf: string | null = null;
    let dropped = 0;
    const inputs: OosSkuInput[] = [];
    // Codes the table does not show, and why — so "is every category here?" has an answer.
    const leftOut = new Map<string, Set<string>>();
    for (const r of rows) {
      if (!r.sku) continue;
      if (r.date_day && (!asOf || r.date_day > asOf)) asOf = r.date_day;
      if (!isSellingState(r.product_state)) {
        const state = (r.product_state ?? '').trim() || 'No product state';
        const key = state.toUpperCase() === 'DISCONTINUED' ? 'Discontinued' : state;
        const set = leftOut.get(key) ?? new Set<string>();
        set.add(norm(r.category) || 'UNCATEGORISED');
        leftOut.set(key, set);
        continue;
      }
      if (excludedSkus.has(norm(r.sku))) {
        dropped += 1;
        continue;
      }
      inputs.push({
        sku: r.sku,
        category: r.category,
        name: r.product_name,
        variant: r.product_variant,
        size: r.size,
        stock: Number(r.current_stock) || 0,
        dailyDemand: Number(r.daily_quantity) || 0,
        oosDays45: Number(r.oos_days_45) || 0,
        oosDays365: Number(r.oos_days_365) || 0,
      });
    }
    const codesLeftOut = [...leftOut.entries()]
      .map(([state, set]) => ({ state, codes: set.size }))
      .sort((a, b) => b.codes - a.codes);
    return { ...summariseOos(inputs), asOf, warehouse: OOS_SUMMARY_WAREHOUSE, excludedSkus: dropped, codesLeftOut };
  } catch {
    return null; // the page must render; the summary shows "not available"
  }
}

/* ------------------------------------------------------------------ */
/* Daily history for the trend                                         */
/* ------------------------------------------------------------------ */

// One row per data day per scope. The first page load for a data day writes it; later
// loads no-op (ON CONFLICT DO NOTHING in the RPC). This guard just saves the round-trip
// on a warm instance.
let lastRecordedDay: string | null = null;

export async function recordOosSnapshot(asOf: string | null, scopes: OosScope[]): Promise<void> {
  if (!asOf || lastRecordedDay === asOf || !scopes.length) return;
  try {
    const supabase = await client();
    await supabase.rpc('sd_record_oos_snapshot', {
      p_day: asOf,
      p_rows: scopes.map((s) => ({
        scope: s.scope,
        skus: s.skus,
        oos_yesterday: s.oosYesterday,
        oos_45: s.oos45,
        oos_365: s.oos365,
        oos_days_45: s.oosDays45,
        oos_days_365: s.oosDays365,
        recovered_45: s.recovered45,
      })),
    });
    lastRecordedDay = asOf;
  } catch {
    /* best-effort */
  }
}

export type OosSnapshotPoint = {
  snapshot_date: string;
  skus: number;
  oos_yesterday: number;
  oos_45: number;
  oos_days_45: number;
  recovered_45: number;
};

/** The overall ('all') history, oldest first, for the OOS% trend chart. */
export async function loadOosSnapshots(): Promise<OosSnapshotPoint[]> {
  try {
    const supabase = await client();
    const { data } = await supabase
      .from('sd_oos_daily_snapshot')
      .select('snapshot_date, skus, oos_yesterday, oos_45, oos_days_45, recovered_45')
      .eq('scope', 'all')
      .order('snapshot_date', { ascending: false }) // latest 400 days …
      .limit(400);
    return ((data ?? []) as OosSnapshotPoint[]).reverse(); // … oldest first for the chart
  } catch {
    return [];
  }
}
