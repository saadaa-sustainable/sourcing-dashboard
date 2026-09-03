import { createClient } from '@/lib/supabase/server';

/**
 * Item 2 — line-item CMTP revision audit. One row per changed CMTP line (old → new
 * amount) with the mandatory reason, who and when. Loaded separately from the
 * accepted-rate history (sd_standard_cost_rate_history) on purpose: the Buying Plan
 * reads the latest rate-history row as the live rate, so CMTP-revision rows (no
 * job/fob/efob rate) must never be mixed into that table. Shown as its own section
 * in the Standard Cost Rate History view.
 */
export type CmtpRevision = {
  id: number;
  product_code: string;
  category: string;
  label: string | null;
  old_amount: number | null;
  new_amount: number | null;
  cm_before: number | null;
  cm_after: number | null;
  reason: string;
  revised_by: string | null;
  revised_at: string;
};

/** Revisions grouped by product_code, newest first. */
export async function loadCmtpRevisions(
  productCodes?: string[],
): Promise<Record<string, CmtpRevision[]>> {
  const supabase = await createClient();
  let query = supabase
    .from('sd_cmtp_revision')
    .select('id, product_code, category, label, old_amount, new_amount, cm_before, cm_after, reason, revised_by, revised_at')
    .order('revised_at', { ascending: false });

  const codes = (productCodes ?? []).map((c) => c.trim()).filter(Boolean);
  if (codes.length) query = query.in('product_code', codes);

  const { data, error } = await query;
  if (error || !data) return {};

  const out: Record<string, CmtpRevision[]> = {};
  for (const row of data as CmtpRevision[]) {
    (out[row.product_code] ??= []).push(row);
  }
  return out;
}
