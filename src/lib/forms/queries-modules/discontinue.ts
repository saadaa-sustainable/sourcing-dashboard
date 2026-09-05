import 'server-only';
import { client, PAGE_SIZE } from './_shared';
import type { DiscontinueRequest } from '../types';
import type { DiscontinuedInventoryRow } from '@/lib/discontinued';

/**
 * Discontinued-products available inventory (serial-level mirror of the Google
 * Sheet) plus a variant -> 45-day-sales map from sd_variant_sales, so the page
 * can flag the "no sales & >365 days" write-off rule. Rolled up to SKU level in
 * the client via lib/discontinued.ts.
 */
export async function loadDiscontinuedInventory(): Promise<{
  rows: DiscontinuedInventoryRow[];
  salesByVariant: Record<string, number>;
}> {
  const supabase = await client();
  const rows: DiscontinuedInventoryRow[] = [];
  for (let from = 0; ; from += PAGE_SIZE) {
    const { data, error } = await supabase
      .from('discontinued_inventory')
      .select(
        'source_row_key, sku, category, sub_category, product_name, color, size, mrp, cost, product_launch_date, product_state, available_inventory, inventory_status, status, serial_number, inward_date, days_in_warehouse',
      )
      .eq('is_active', true)
      .order('sku', { ascending: true })
      .range(from, from + PAGE_SIZE - 1);
    if (error) throw new Error(`discontinued_inventory: ${error.message}`);
    if (!data?.length) break;
    rows.push(...(data as DiscontinuedInventoryRow[]));
    if (data.length < PAGE_SIZE) break;
  }

  const { data: sales } = await supabase
    .from('sd_variant_sales')
    .select('product_variant, sales_45d');
  const salesByVariant: Record<string, number> = {};
  (
    (sales ?? []) as { product_variant: string | null; sales_45d: number | null }[]
  ).forEach((s) => {
    const v = (s.product_variant ?? '').trim();
    if (v) salesByVariant[v] = Number(s.sales_45d) || 0;
  });

  return { rows, salesByVariant };
}

/* ------------------------------------------------------------------ */
/* Discontinue                                                         */
/* ------------------------------------------------------------------ */

export async function loadDiscontinueRequests() {
  const supabase = await client();
  const { data } = await supabase
    .from('sd_discontinue_request')
    .select('*')
    .order('id', { ascending: false })
    .limit(500);

  const { data: variants } = await supabase
    .from('sd_active_variants')
    .select('product_code, product_variant')
    .limit(PAGE_SIZE);

  return {
    requests: (data ?? []) as DiscontinueRequest[],
    variants: (variants ?? []) as { product_code: string; product_variant: string }[],
  };
}
