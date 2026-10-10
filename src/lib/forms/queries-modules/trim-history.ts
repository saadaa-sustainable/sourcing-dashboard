import 'server-only';
import { client } from './_shared';

/** One change to a trim line of a product's CMTP (sd_trim_history). */
export type TrimChange = {
  id: number;
  product_code: string;
  trim_head: string;
  item: string | null;
  old_amount: number | null;
  new_amount: number | null;
  change_kind: 'added' | 'changed' | 'removed' | 'on_file';
  reason: string | null;
  changed_by: string | null;
  changed_at: string;
};

/**
 * A product's trim history, newest first.
 *   ready: false — the table does not exist yet (migration 20261009160000 not applied)
 */
export async function loadTrimHistory(productCode: string): Promise<{ ready: boolean; changes: TrimChange[] }> {
  const supabase = await client();
  // paging-ok: one product's trim changes — a dozen trims, a few changes each
  const { data, error } = await supabase
    .from('sd_trim_history' as never)
    .select('id, product_code, trim_head, item, old_amount, new_amount, change_kind, reason, changed_by, changed_at')
    .eq('product_code', productCode)
    .order('changed_at', { ascending: false })
    .order('id', { ascending: false })
    .limit(1000);
  if (error) return { ready: false, changes: [] };
  return {
    ready: true,
    changes: ((data ?? []) as unknown as TrimChange[]).map((r) => ({
      ...r,
      old_amount: r.old_amount == null ? null : Number(r.old_amount),
      new_amount: r.new_amount == null ? null : Number(r.new_amount),
    })),
  };
}
