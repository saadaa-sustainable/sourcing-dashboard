import { createClient } from '@/lib/supabase/server';

/**
 * Item 2 — category mapping editor data. For every catalog product code: the EFFECTIVE
 * category/sub-category (what the app reads, post-coalesce from sd_product_catalog) and
 * the team OVERRIDE actually stored on sd_product_master. "Missing" = no effective
 * category at all (neither an override nor an EasyEcom value) — the backlog to fill.
 */
export type CategoryMapRow = {
  product_code: string;
  product_name: string | null;
  effectiveCategory: string | null;
  effectiveSubCategory: string | null;
  overrideCategory: string | null;
  overrideSubCategory: string | null;
};

export type CategoryMapState = {
  rows: CategoryMapRow[];
  missingCount: number;
  categoryOptions: string[];
  subCategoryOptions: string[];
};

export async function loadCategoryMapState(): Promise<CategoryMapState> {
  const supabase = await createClient();
  const [{ data: catalog }, { data: overrides }] = await Promise.all([
    supabase.from('sd_product_catalog').select('product_code, product_name, category, sub_category'),
    supabase.from('sd_product_master').select('product_code, category, sub_category'),
  ]);

  const ovByCode = new Map(
    (overrides ?? []).map((o) => [String(o.product_code), o]),
  );

  const rows: CategoryMapRow[] = (catalog ?? [])
    .map((c) => {
      const ov = ovByCode.get(String(c.product_code));
      return {
        product_code: String(c.product_code),
        product_name: (c.product_name as string | null) ?? null,
        effectiveCategory: (c.category as string | null) ?? null,
        effectiveSubCategory: (c.sub_category as string | null) ?? null,
        overrideCategory: (ov?.category as string | null) ?? null,
        overrideSubCategory: (ov?.sub_category as string | null) ?? null,
      };
    })
    .sort((a, b) => a.product_code.localeCompare(b.product_code));

  // Existing distinct values (from the effective column) to offer as datalist options,
  // so the team reuses canonical names rather than free-typing variants.
  const categoryOptions = [...new Set(rows.map((r) => r.effectiveCategory).filter(Boolean) as string[])].sort();
  const subCategoryOptions = [...new Set(rows.map((r) => r.effectiveSubCategory).filter(Boolean) as string[])].sort();

  return {
    rows,
    missingCount: rows.filter((r) => !r.effectiveCategory || !r.effectiveSubCategory).length,
    categoryOptions,
    subCategoryOptions,
  };
}
