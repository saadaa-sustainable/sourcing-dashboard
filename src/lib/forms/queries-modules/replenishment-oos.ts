import 'server-only';
import { client, PAGE_SIZE, pageAll } from './_shared';
import { skuKey } from '@/lib/sku-key';
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
  return pageAll<ReplenishmentRow>(() =>
    supabase
      .from('sd_replenishment')
      .select('*')
      // The page shows 30 / 60 / 90-day cover: a colour that only needs a 60/90-day
      // buy (rop_30 = 0) must still be listed.
      .or('rop_30.gt.0,rop_60.gt.0,rop_90.gt.0')
      .order('rop_30', { ascending: false })
      .order('rop_90', { ascending: false })
      // Tie-break so pages never overlap (many colours share the same ROPs).
      .order('product_variant'),
  ).catch((e: Error) => {
    throw new Error(`sd_replenishment: ${e.message}`);
  });
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

/**
 * The OOS Calculation sheet — one row per SKU, read-only. Paged (can exceed 1000).
 * In process is NOT the synced BigQuery figure (it ran ~10x the open POs): it is the pending qty
 * on approved POs from sd_sku_in_process. Current stock is the Main Warehouse row only (the sync
 * adds every warehouse — FBA, store, Holisol). DOH and DOH with in-process are recomputed.
 */
export async function loadOosCalculation(): Promise<OosCalculationRow[]> {
  const supabase = await client();
  const [rows, ip, main] = await Promise.all([
    pageAll<OosCalculationRow>(() => supabase.from('sd_oos_calculation').select('*').order('sku')).catch((e: Error) => {
      throw new Error(`sd_oos_calculation: ${e.message}`);
    }),
    pageAll<{ sku_key: string; in_process_qty: number | null }>(() =>
      supabase.from('sd_sku_in_process').select('sku_key, in_process_qty').order('sku_key'),
    ).catch((e: Error) => {
      throw new Error(`sd_sku_in_process: ${e.message}`);
    }),
    pageAll<{ sku: string; current_stock: number | null }>(() =>
      supabase.from('sd_inventory_planning').select('sku, current_stock').eq('warehouse', 'Main Warehouse').order('row_key'),
    ).catch((e: Error) => {
      throw new Error(`sd_inventory_planning: ${e.message}`);
    }),
  ]);
  const key = (sku: string) => sku.trim().toUpperCase().replace(/_/g, '');
  const ipBySku = new Map(ip.map((r) => [r.sku_key, Number(r.in_process_qty) || 0]));
  const mainStock = new Map<string, number>();
  for (const r of main) mainStock.set(key(r.sku), (mainStock.get(key(r.sku)) ?? 0) + (Number(r.current_stock) || 0));
  return rows.map((r) => {
    const inprocess = ipBySku.get(key(r.sku)) ?? 0;
    const stock = mainStock.get(key(r.sku)) ?? 0;
    const doq = Number(r.doq_45) || 0;
    const days = (v: number) => (doq ? Math.round((v / doq) * 10) / 10 : null);
    return {
      ...r,
      current_stock: stock,
      doh: days(stock),
      inprocess_stock: inprocess,
      doh_with_inprocess: days(stock + inprocess),
    };
  });
}

/** Team-managed SKU exclusion list for the OOS Calculation view. */
export async function loadOosExclusions(): Promise<OosSkuExclusion[]> {
  const supabase = await client();
  // Every SKU not on the team's OOS SKU list sits here too, so the table is thousands long.
  const rows = await pageAll<OosSkuExclusion>(() =>
    supabase
      .from('sd_oos_sku_exclusion')
      .select('*')
      .order('added_at', { ascending: false })
      .order('sku'),
  );
  // Product names from the master, so the list reads as products, not just codes.
  const names = new Map<string, string>();
  const skus = rows.map((r) => r.sku);
  const chunks: string[][] = [];
  for (let i = 0; i < skus.length; i += 200) chunks.push(skus.slice(i, i + 200));
  // The ~17 chunks run together rather than one after another.
  const results = await Promise.all(
    chunks.map((chunk) =>
      // paging-ok: one chunk of at most 200 SKUs, one row each
      supabase.from('sd_ee_product_master').select('sku, product_name, colour, size').in('sku', chunk),
    ),
  );
  for (const { data: pm } of results) {
    for (const r of (pm ?? []) as { sku: string; product_name: string | null; colour: string | null; size: string | null }[]) {
      names.set(skuKey(r.sku), [r.product_name, r.colour, r.size].filter(Boolean).join(' · '));
    }
  }
  return rows.map((r) => ({ ...r, product_name: names.get(skuKey(r.sku)) ?? null }));
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
  // Ordered by the key: unordered pages are not guaranteed to be disjoint.
  const rows = await pageAll<DoqWindowRow>(() => supabase.from('sd_doq_window').select('*').order('sku')).catch((e: Error) => {
    throw new Error(`sd_doq_window: ${e.message}`);
  });
  const map: Record<string, DoqWindowRow> = {};
  for (const r of rows) map[r.sku] = r;
  return map;
}

/** Per-SKU IPDOQ inputs (doq_45 / doq_365 / oos_days_45, max across warehouses)
 *  for Product Class computation. From the latest inventory snapshot. */
export async function loadSkuClassInputs(): Promise<
  Record<string, { doq45: number; doq365: number; oos45: number }>
> {
  const supabase = await client();
  const map: Record<string, { doq45: number; doq365: number; oos45: number }> = {};
  // Ordered by the key: unordered pages are not guaranteed to be disjoint.
  const rows = await pageAll<{ sku: string | null; doq_45: number | null; doq_365: number | null; oos_days_45: number | null }>(() =>
    supabase.from('sd_inventory_planning').select('sku, doq_45, doq_365, oos_days_45').order('row_key'),
  ).catch((e: Error) => {
    throw new Error(`sd_inventory_planning: ${e.message}`);
  });
  for (const r of rows) {
    if (!r.sku) continue;
    const cur = (map[r.sku] ??= { doq45: 0, doq365: 0, oos45: 0 });
    cur.doq45 = Math.max(cur.doq45, r.doq_45 ?? 0);
    cur.doq365 = Math.max(cur.doq365, r.doq_365 ?? 0);
    cur.oos45 = Math.max(cur.oos45, r.oos_days_45 ?? 0);
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
  Record<string, { launch: string | null; mrp: number | null; state: string | null }>
> {
  const supabase = await client();
  // Keyed by skuKey: the master spells SDCPBL_S, the feed SDCPBLS — look up with skuKey too.
  const map: Record<string, { launch: string | null; mrp: number | null; state: string | null }> = {};
  const rows = await pageAll<{ sku: string; product_launch_date: string | null; mrp: string | null; product_state: string | null }>(() =>
    supabase.from('sd_ee_product_master').select('sku, product_launch_date, mrp, product_state').order('sku'),
  ).catch((e: Error) => {
    throw new Error(`sd_ee_product_master: ${e.message}`);
  });
  for (const r of rows) {
    if (!r.sku) continue;
    const k = skuKey(r.sku);
    const mrp = Number(r.mrp);
    // A junk spelling ("SMFLKBL_ 3XL") shares the key with the real SKU; the real row
    // (plain CODE_SIZE) wins, a placeholder never overwrites it.
    if (map[k] && !/^[A-Za-z0-9_]+$/.test(r.sku)) continue;
    map[k] = {
      launch: r.product_launch_date || null,
      mrp: Number.isFinite(mrp) && mrp > 0 ? mrp : null,
      state: r.product_state?.trim() || null,
    };
  }
  return map;
}

/** Daily DOQ snapshot (sd_inventory_planning) — one row per SKU×warehouse. Paged (exceeds 1000). */
export async function loadDoqDataset(): Promise<DoqInventoryRow[]> {
  const supabase = await client();
  // sku + row_key: sku alone repeats (one row per warehouse), so pages could overlap.
  return pageAll<DoqInventoryRow>(() => supabase.from('sd_inventory_planning').select('*').order('sku').order('row_key')).catch((e: Error) => {
    throw new Error(`sd_inventory_planning: ${e.message}`);
  });
}
