import 'server-only';
import { client } from './_shared';
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
    .select('id, product_code, doc_group, file_name, file_size, remark, created_by, created_at')
    .eq('product_code', productCode)
    .order('id')
    .limit(500);
  if (error) return { ready: false, docs: [] };
  return { ready: true, docs: (data ?? []) as unknown as CostDocument[] };
}
