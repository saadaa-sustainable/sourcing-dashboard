import 'server-only';
import { client, PAGE_SIZE } from './_shared';
import type {
  ReplenishmentRow,
  VendorRecommendationRow,
  OosCalculationRow,
  OosSkuExclusion,
  DoqWindowRow,
  DoqWindowMeta,
  DoqInventoryRow,
} from '../types';

/** Replenishment recommendations (colours needing reorder), for the module page. */
export async function loadReplenishment(): Promise<ReplenishmentRow[]> {
  const supabase = await client();
  const rows: ReplenishmentRow[] = [];
  for (let from = 0; ; from += PAGE_SIZE) {
    const { data, error } = await supabase
      .from('sd_replenishment')
      .select('*')
      .gt('rop_30', 0)
      .order('rop_30', { ascending: false })
      .range(from, from + PAGE_SIZE - 1);
    if (error) throw new Error(`sd_replenishment: ${error.message}`);
    if (!data?.length) break;
    rows.push(...(data as ReplenishmentRow[]));
    if (data.length < PAGE_SIZE) break;
  }
  return rows;
}

/** Product-code → ROP quantities, feeding the Buying Plan's computed Pending Qty. */
export async function loadReplenishmentByProduct(): Promise<
  Record<string, { rop_30: number; rop_60: number; rop_90: number }>
> {
  const supabase = await client();
  const { data } = await supabase
    .from('sd_replenishment_by_product')
    .select('product_code, rop_30, rop_60, rop_90')
    .limit(PAGE_SIZE);
  const map: Record<string, { rop_30: number; rop_60: number; rop_90: number }> = {};
  (
    (data ?? []) as { product_code: string; rop_30: number; rop_60: number; rop_90: number }[]
  ).forEach((r) => {
    map[r.product_code] = {
      rop_30: Number(r.rop_30) || 0,
      rop_60: Number(r.rop_60) || 0,
      rop_90: Number(r.rop_90) || 0,
    };
  });
  return map;
}

/** Per-vendor completed-PO performance (completion / on-time / delay) for the
 *  Vendor Recommendation screen. From sd_vendor_recommendation (live source). */
export async function loadVendorRecommendation(): Promise<VendorRecommendationRow[]> {
  const supabase = await client();
  const { data, error } = await supabase
    .from('sd_vendor_recommendation')
    .select('*')
    .limit(PAGE_SIZE);
  if (error) throw new Error(`sd_vendor_recommendation: ${error.message}`);
  return (data ?? []) as VendorRecommendationRow[];
}

/** The OOS Calculation sheet — one row per SKU, read-only. Paged (can exceed 1000). */
export async function loadOosCalculation(): Promise<OosCalculationRow[]> {
  const supabase = await client();
  const rows: OosCalculationRow[] = [];
  for (let from = 0; ; from += PAGE_SIZE) {
    const { data, error } = await supabase
      .from('sd_oos_calculation')
      .select('*')
      .order('sku')
      .range(from, from + PAGE_SIZE - 1);
    if (error) throw new Error(`sd_oos_calculation: ${error.message}`);
    rows.push(...((data ?? []) as OosCalculationRow[]));
    if (!data || data.length < PAGE_SIZE) break;
  }
  return rows;
}

/** Team-managed SKU exclusion list for the OOS Calculation view. */
export async function loadOosExclusions(): Promise<OosSkuExclusion[]> {
  const supabase = await client();
  const { data, error } = await supabase
    .from('sd_oos_sku_exclusion')
    .select('*')
    .order('added_at', { ascending: false })
    .limit(PAGE_SIZE);
  if (error) throw new Error(`sd_oos_sku_exclusion: ${error.message}`);
  return (data ?? []) as OosSkuExclusion[];
}

/** The snapshot date whose data the OOS/DOQ tabs are showing, + last refresh. */
export async function loadOosMeta(): Promise<{ dataAsOf: string | null; lastSynced: string | null }> {
  const supabase = await client();
  const [{ data: day }, { data: sync }] = await Promise.all([
    supabase
      .from('sd_inventory_planning')
      .select('date_day')
      .order('date_day', { ascending: false })
      .limit(1),
    supabase
      .from('sd_oos_calculation')
      .select('synced_at')
      .order('synced_at', { ascending: false })
      .limit(1),
  ]);
  return {
    dataAsOf: (day?.[0] as { date_day?: string } | undefined)?.date_day ?? null,
    lastSynced: (sync?.[0] as { synced_at?: string } | undefined)?.synced_at ?? null,
  };
}

/** Per-SKU DOQ-dashboard window aggregates, keyed by SKU. Paged (12k+ rows). */
export async function loadDoqWindows(): Promise<Record<string, DoqWindowRow>> {
  const supabase = await client();
  const map: Record<string, DoqWindowRow> = {};
  for (let from = 0; ; from += PAGE_SIZE) {
    const { data, error } = await supabase
      .from('sd_doq_window')
      .select('*')
      .range(from, from + PAGE_SIZE - 1);
    if (error) throw new Error(`sd_doq_window: ${error.message}`);
    for (const r of (data ?? []) as DoqWindowRow[]) map[r.sku] = r;
    if (!data || data.length < PAGE_SIZE) break;
  }
  return map;
}

/** Per-SKU IPDOQ inputs (doq_45 / doq_365 / oos_days_45, max across warehouses)
 *  for Product Class computation. From the latest inventory snapshot. */
export async function loadSkuClassInputs(): Promise<
  Record<string, { doq45: number; doq365: number; oos45: number }>
> {
  const supabase = await client();
  const map: Record<string, { doq45: number; doq365: number; oos45: number }> = {};
  for (let from = 0; ; from += PAGE_SIZE) {
    const { data, error } = await supabase
      .from('sd_inventory_planning')
      .select('sku, doq_45, doq_365, oos_days_45')
      .range(from, from + PAGE_SIZE - 1);
    if (error) throw new Error(`sd_inventory_planning: ${error.message}`);
    for (const r of (data ?? []) as { sku: string | null; doq_45: number | null; doq_365: number | null; oos_days_45: number | null }[]) {
      if (!r.sku) continue;
      const cur = (map[r.sku] ??= { doq45: 0, doq365: 0, oos45: 0 });
      cur.doq45 = Math.max(cur.doq45, r.doq_45 ?? 0);
      cur.doq365 = Math.max(cur.doq365, r.doq_365 ?? 0);
      cur.oos45 = Math.max(cur.oos45, r.oos_days_45 ?? 0);
    }
    if (!data || data.length < PAGE_SIZE) break;
  }
  return map;
}

/** Window descriptors (labels, ranges, day counts) for the DOQ dashboard. */
export async function loadDoqWindowMeta(): Promise<DoqWindowMeta | null> {
  const supabase = await client();
  const { data } = await supabase
    .from('sd_doq_window_meta')
    .select('windows')
    .eq('id', 1)
    .maybeSingle();
  return ((data as { windows?: DoqWindowMeta } | null)?.windows) ?? null;
}

/** sku → launch date + MRP from the EasyEcom product master, for OOS fallbacks. */
export async function loadPmLaunchPrice(): Promise<
  Record<string, { launch: string | null; mrp: number | null }>
> {
  const supabase = await client();
  const map: Record<string, { launch: string | null; mrp: number | null }> = {};
  for (let from = 0; ; from += PAGE_SIZE) {
    const { data, error } = await supabase
      .from('sd_ee_product_master')
      .select('sku, product_launch_date, mrp')
      .range(from, from + PAGE_SIZE - 1);
    if (error) throw new Error(`sd_ee_product_master: ${error.message}`);
    for (const r of (data ?? []) as { sku: string; product_launch_date: string | null; mrp: string | null }[]) {
      if (!r.sku) continue;
      const mrp = Number(r.mrp);
      map[r.sku] = {
        launch: r.product_launch_date || null,
        mrp: Number.isFinite(mrp) && mrp > 0 ? mrp : null,
      };
    }
    if (!data || data.length < PAGE_SIZE) break;
  }
  return map;
}

/** Daily DOQ snapshot (sd_inventory_planning) — one row per SKU×warehouse. Paged (exceeds 1000). */
export async function loadDoqDataset(): Promise<DoqInventoryRow[]> {
  const supabase = await client();
  const rows: DoqInventoryRow[] = [];
  for (let from = 0; ; from += PAGE_SIZE) {
    const { data, error } = await supabase
      .from('sd_inventory_planning')
      .select('*')
      .order('sku')
      .range(from, from + PAGE_SIZE - 1);
    if (error) throw new Error(`sd_inventory_planning: ${error.message}`);
    rows.push(...((data ?? []) as DoqInventoryRow[]));
    if (!data || data.length < PAGE_SIZE) break;
  }
  return rows;
}
