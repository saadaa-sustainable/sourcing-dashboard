import 'server-only';
import { client } from './_shared';
import type { CostDocGroup, CostDocument } from '@/lib/cost-documents';

/**
 * A product's CAD plans / documents, oldest first.
 *   ready: false   — the table does not exist yet (migration 20261009100000 not applied)
 *   linksReady     — the width + link columns exist (migration 20261009130000); before that the
 *                    old 58″ / 56″ rows are read and shown as Full layer entries, and adding a
 *                    width link is held back.
 */
export async function loadCostDocuments(
  productCode: string,
): Promise<{ ready: boolean; linksReady: boolean; docs: CostDocument[] }> {
  const supabase = await client();
  // paging-ok: one product's documents, a handful per CAD group
  const { data, error } = await supabase
    .from('sd_cost_document' as never)
    .select('id, product_code, doc_group, file_name, file_size, remark, width, link_url, created_by, created_at')
    .eq('product_code', productCode)
    .order('id')
    .limit(500);
  if (!error) return { ready: true, linksReady: true, docs: (data ?? []) as unknown as CostDocument[] };

  // paging-ok: same one-product read, on the columns before 20261009130000
  const old = await supabase
    .from('sd_cost_document' as never)
    .select('id, product_code, doc_group, file_name, file_size, remark, created_by, created_at')
    .eq('product_code', productCode)
    .order('id')
    .limit(500);
  if (old.error) return { ready: false, linksReady: false, docs: [] };
  const docs = ((old.data ?? []) as unknown as (Omit<CostDocument, 'width' | 'link_url' | 'doc_group'> & { doc_group: string })[]).map((d) => {
    const legacy = /^full_layer_(\d+)$/.exec(d.doc_group);
    return {
      ...d,
      doc_group: (legacy ? 'full_layer' : d.doc_group) as CostDocGroup,
      width: legacy ? legacy[1] : null,
      link_url: null,
    };
  });
  return { ready: true, linksReady: false, docs };
}
