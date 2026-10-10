import 'server-only';
import { createClient } from '@/lib/supabase/server';
import { pageAll } from '@/lib/forms/queries-modules/_shared';
import { loadNpdMaster, NpdNotConfiguredError, type NpdMasterRow } from '@/lib/npd-tracker.server';

/**
 * Master → NPD Products: every NPD Tracker V7 product with where it stands on the dashboard
 * (added to Standard Cost, linked to its EasyEcom code, can be added, blocked, launched).
 * `error` is set (and rows empty) when NPD is not connected or cannot be read.
 */
export async function loadNpdMasterPage(): Promise<{ rows: NpdMasterRow[]; error: string | null }> {
  const supabase = await createClient();
  try {
    const [temps, sheet, catalog] = await Promise.all([
      pageAll<{ temp_code: string; status: string; merged_into: string | null; created_by: string | null; created_at: string | null; npd_product_id: number | null }>(() =>
        supabase
          .from('sd_temp_product')
          .select('temp_code, status, merged_into, created_by, created_at, npd_product_id')
          .eq('source', 'npd')
          .order('temp_code'),
      ),
      pageAll<{ product_code: string }>(() => supabase.from('sd_standard_cost').select('product_code').order('product_code')),
      pageAll<{ product_code: string }>(() => supabase.from('sd_product_catalog').select('product_code').order('product_code')),
    ]);
    const registered = new Map<number, { code: string; status: string; merged_into: string | null; created_by: string | null; created_at: string | null }>();
    for (const t of temps) {
      if (t.npd_product_id == null) continue;
      // An active registration wins over an older merged one for the same NPD row.
      const prev = registered.get(Number(t.npd_product_id));
      if (prev && prev.status === 'active') continue;
      registered.set(Number(t.npd_product_id), {
        code: t.temp_code,
        status: t.status,
        merged_into: t.merged_into,
        created_by: t.created_by,
        created_at: t.created_at,
      });
    }
    const rows = await loadNpdMaster({
      registered,
      onSheet: new Set(sheet.map((r) => String(r.product_code).toUpperCase())),
      inEasyEcom: new Set(catalog.map((r) => String(r.product_code).toUpperCase())),
    });
    return { rows, error: null };
  } catch (e) {
    if (e instanceof NpdNotConfiguredError) return { rows: [], error: e.message };
    return { rows: [], error: `Could not read NPD Tracker V7: ${e instanceof Error ? e.message : String(e)}` };
  }
}
