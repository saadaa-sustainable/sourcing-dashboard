import 'server-only';
import { client, pageAll } from './_shared';
import type { CostDocument } from '@/lib/cost-documents';

/**
 * A product's CAD plans / documents, oldest first. `ready: false` when the table does not
 * exist yet (migration 20261009100000 not applied) so the page can say so instead of failing.
 */
export async function loadCostDocuments(productCode: string): Promise<{ ready: boolean; docs: CostDocument[] }> {
  const supabase = await client();
  // paging-ok: one product's documents, a handful per CAD group
  const { data, error } = await supabase
    .from('sd_cost_document' as never)
    .select('id, product_code, doc_group, file_name, file_size, remark, status, created_by, submitted_at, l1_approved_by, l1_approved_at, approved_by, approved_at, rework_notes, rejection_notes, approver_edited')
    .eq('product_code', productCode)
    .order('id')
    .limit(500);
  if (error) return { ready: false, docs: [] };
  return { ready: true, docs: (data ?? []) as unknown as CostDocument[] };
}

/** Who may do the L1 CAD check. Empty = nobody named, so any team member may. */
export async function loadCadCheckers(): Promise<string[]> {
  const supabase = await client();
  // paging-ok: a few named people
  const { data, error } = await supabase.from('sd_cad_checker' as never).select('email').order('email').limit(100);
  if (error) return [];
  return ((data ?? []) as unknown as { email: string }[]).map((r) => r.email.toLowerCase());
}

/** CAD documents waiting at either level, for the Approvals queue (tolerates a missing table). */
export async function loadPendingCostDocuments(): Promise<CostDocument[]> {
  const supabase = await client();
  try {
    return await pageAll<CostDocument>(() =>
      supabase
        .from('sd_cost_document' as never)
        .select('id, product_code, doc_group, file_name, file_size, remark, status, created_by, submitted_at, l1_approved_by, l1_approved_at, approved_by, approved_at, rework_notes, rejection_notes, approver_edited')
        .in('status', ['submitted', 'pending_l2'])
        .order('id') as never,
    );
  } catch {
    return [];
  }
}
