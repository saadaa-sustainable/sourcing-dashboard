import { createClient } from '@/lib/supabase/server';

/**
 * Product → fabric relation from Product Master (sd_product_fabric view). fabricCode is
 * the raw/greige fabric SKU (rm_fabric_sku), which is the fabric_code the fabric-cost +
 * per-fabric EFOB tables key on. Only set when the product maps to ONE fabric; a
 * multi-fabric product has fabricCode = null + multi = true (left to manual selection).
 */
export type ProductFabric = { fabricCode: string | null; multi: boolean };

export async function loadProductFabricMap(): Promise<Record<string, ProductFabric>> {
  try {
    const supabase = await createClient();
    const { data } = await supabase
      .from('sd_product_fabric')
      .select('product_code, fabric_code, multi_fabric');
    const out: Record<string, ProductFabric> = {};
    for (const r of data ?? []) {
      out[String(r.product_code)] = {
        fabricCode: (r.fabric_code as string | null) ?? null,
        multi: Boolean(r.multi_fabric),
      };
    }
    return out;
  } catch {
    return {};
  }
}
