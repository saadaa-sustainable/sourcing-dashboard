import { createClient } from '@/lib/supabase/server';
import type { ProductCatalogItem } from '@/lib/forms/types';

export type TempProductInfo = {
  name: string | null;
  status: 'active' | 'merged';
  merged_into: string | null;
};

/**
 * Temp products keyed by their code — for badging rows in Standard Cost and driving
 * the merge control. Includes merged ones (so history reads correctly).
 */
export async function loadTempProductMap(): Promise<Record<string, TempProductInfo>> {
  try {
    const supabase = await createClient();
    const { data } = await supabase
      .from('sd_temp_product')
      .select('temp_code, name, status, merged_into');
    const out: Record<string, TempProductInfo> = {};
    for (const t of data ?? []) {
      out[t.temp_code as string] = {
        name: (t.name as string | null) ?? null,
        status: (t.status as 'active' | 'merged') ?? 'active',
        merged_into: (t.merged_into as string | null) ?? null,
      };
    }
    return out;
  } catch {
    return {};
  }
}

/**
 * The product universe for Buying Plan / PO when the restrict-to-Standard-Cost rule
 * is on: every non-hidden Standard Cost product (real + temp), named from the temp
 * registry or the catalog, shaped as ProductCatalogItem for the shared picker.
 */
export async function loadStandardCostProductOptions(): Promise<ProductCatalogItem[]> {
  const supabase = await createClient();
  const [{ data: sc }, { data: cat }, { data: temp }] = await Promise.all([
    supabase.from('sd_standard_cost').select('product_code, hidden'),
    supabase.from('sd_product_catalog').select('product_code, product_name, category, sub_category'),
    supabase.from('sd_temp_product').select('temp_code, name, status'),
  ]);
  const catByCode = new Map((cat ?? []).map((c) => [String(c.product_code), c]));
  const tempByCode = new Map((temp ?? []).map((t) => [String(t.temp_code), t]));

  const out: ProductCatalogItem[] = [];
  const seen = new Set<string>();
  for (const r of sc ?? []) {
    if (r.hidden) continue;
    const code = String(r.product_code);
    if (seen.has(code)) continue;
    seen.add(code);
    const c = catByCode.get(code);
    const t = tempByCode.get(code);
    out.push({
      product_code: code,
      product_name: (t?.name as string | null) ?? (c?.product_name as string | null) ?? null,
      category: (c?.category as string | null) ?? (t ? 'Temporary' : null),
      sub_category: (c?.sub_category as string | null) ?? null,
    });
  }
  return out.sort((a, b) => a.product_code.localeCompare(b.product_code));
}
