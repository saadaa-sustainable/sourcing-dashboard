import { createClient } from '@/lib/supabase/server';

/**
 * Effective launch date per product_code, read from the sd_product_launch_date view
 * (first_sale if valid, else first_grn, else absent). A product with NO launch signal
 * simply isn't in the map → callers must treat "absent" as "no launch data yet", never
 * default it to today. days_since_launch is already floored at 1 (divide-by-1 guard).
 */
export type ProductLaunch = {
  firstSaleDate: string | null;
  firstGrnDate: string | null;
  effectiveLaunchDate: string | null;
  daysSinceLaunch: number | null;
};

export async function loadProductLaunchDates(): Promise<Record<string, ProductLaunch>> {
  try {
    const supabase = await createClient();
    const { data } = await supabase
      .from('sd_product_launch_date')
      .select('product_code, first_sale_date, first_grn_date, effective_launch_date, days_since_launch');
    const out: Record<string, ProductLaunch> = {};
    for (const r of data ?? []) {
      out[String(r.product_code)] = {
        firstSaleDate: (r.first_sale_date as string | null) ?? null,
        firstGrnDate: (r.first_grn_date as string | null) ?? null,
        effectiveLaunchDate: (r.effective_launch_date as string | null) ?? null,
        daysSinceLaunch: r.days_since_launch == null ? null : Number(r.days_since_launch),
      };
    }
    return out;
  } catch {
    return {};
  }
}
