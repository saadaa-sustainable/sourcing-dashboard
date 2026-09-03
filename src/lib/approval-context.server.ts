// Server-only: imports the cookie-bound Supabase client (next/headers), so it
// can never be pulled into a client bundle. Called only from the approvals page.
import { createClient } from '@/lib/supabase/server';
import {
  computeApprovalContext,
  COLOR_IN_STOCK_THRESHOLD_DEFAULT,
  type ApprovalContext,
  type ContextSku,
} from '@/lib/approval-context';

/**
 * Load the approval-time context (spec item 1) for a set of product codes,
 * keyed by product_code. Per-SKU rows come from sd_oos_calculation (colour,
 * size, state, current stock); product-level DOQ / stock / in-process come from
 * sd_replenishment_by_product (IPDOQ). The 75% colour threshold is read live
 * from the Rules Master. Returns {} for any code with no data — the panel shows
 * "no data" rather than a fake zero.
 */
export async function loadApprovalContext(
  productCodes: string[],
): Promise<Record<string, ApprovalContext>> {
  const codes = [...new Set(productCodes.filter(Boolean))];
  if (!codes.length) return {};

  const supabase = await createClient();

  const [{ data: skuRows }, { data: prod }, { data: rule }] = await Promise.all([
    supabase
      .from('sd_oos_calculation')
      .select('product_code, color, size, product_status, current_stock')
      .in('product_code', codes),
    supabase
      .from('sd_replenishment_by_product')
      .select('product_code, ipdoq, current_stock, in_progress')
      .in('product_code', codes),
    supabase
      .from('sd_analytics_rule')
      .select('value')
      .eq('rule_key', 'color_in_stock_threshold')
      .maybeSingle(),
  ]);

  const threshold =
    rule && (rule as { value?: number }).value != null
      ? Number((rule as { value: number }).value)
      : COLOR_IN_STOCK_THRESHOLD_DEFAULT;

  const skusByCode = new Map<string, ContextSku[]>();
  for (const r of (skuRows ?? []) as {
    product_code: string | null;
    color: string | null;
    size: string | null;
    product_status: string | null;
    current_stock: number | null;
  }[]) {
    if (!r.product_code) continue;
    const list = skusByCode.get(r.product_code) ?? [];
    list.push({
      color: r.color,
      size: r.size,
      productStatus: r.product_status,
      currentStock: Number(r.current_stock) || 0,
    });
    skusByCode.set(r.product_code, list);
  }

  const prodByCode = new Map<string, { ipdoq: number; currentStock: number; inProcess: number }>();
  for (const r of (prod ?? []) as {
    product_code: string;
    ipdoq: number | null;
    current_stock: number | null;
    in_progress: number | null;
  }[]) {
    prodByCode.set(r.product_code, {
      ipdoq: Number(r.ipdoq) || 0,
      currentStock: Number(r.current_stock) || 0,
      inProcess: Number(r.in_progress) || 0,
    });
  }

  const out: Record<string, ApprovalContext> = {};
  for (const code of codes) {
    const skus = skusByCode.get(code);
    const p = prodByCode.get(code) ?? { ipdoq: 0, currentStock: 0, inProcess: 0 };
    // Skip codes with no SKU data AND no product-level figures — nothing to show.
    if (!skus?.length && p.ipdoq === 0 && p.currentStock === 0 && p.inProcess === 0) continue;
    out[code] = computeApprovalContext(skus ?? [], p, threshold);
  }
  return out;
}
