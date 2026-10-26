import 'server-only';
import { cache } from 'react';
import { createAdminClient } from './supabase/admin';
import { loadProductCatalog } from './forms/queries';
import { pageAll } from './forms/queries-modules/_shared';
import { loadNpdCostMasterOptions, NpdNotConfiguredError } from './npd-tracker.server';
import { costWorkflowUser } from './standard-cost-workflow.server';
import { easyEcomCostProducts, type FinishedGoodsCostProduct } from './finished-goods-cost';

/** Authoritative master universe, including products with no Standard Cost row yet. */
export const loadFinishedGoodsCostProducts = cache(async () => {
  await costWorkflowUser();
  const db = createAdminClient();
  const [skus, catalog, npd, registry] = await Promise.all([
    pageAll<{ sku: string; product_variant: string | null; product_name: string | null }>(() => db.from('sd_ee_product_master').select('sku, product_variant, product_name').order('sku')),
    loadProductCatalog(),
    loadNpdCostMasterOptions()
      .then(options => ({ options, error: '' }))
      .catch((error: unknown) => ({ options: [], error: error instanceof NpdNotConfiguredError ? 'NPD Tracker is not connected. Contact an administrator to connect it.' : 'NPD Tracker could not be loaded. Try again or contact an administrator.' })),
    pageAll<{ npd_product_id: number | null; status: string; merged_into: string | null }>(() => db.from('sd_temp_product').select('npd_product_id, status, merged_into').eq('source','npd').order('temp_code')),
  ]);
  const products = new Map(easyEcomCostProducts(skus, catalog).map(p => [p.code, p]));
  const linkedById = new Map(registry.filter(r => r.status === 'merged').map(r => [r.npd_product_id, r]));
  for (const row of npd.options) {
    if (!row.code || row.blocked || products.has(row.code)) continue;
    const linked = linkedById.get(row.id);
    if (linked) {
      const target = products.get(linked.merged_into?.toUpperCase() ?? '');
      if (target) target.skus.push(row.code, row.sku_code);
      continue;
    }
    products.set(row.code, { code: row.code, name: row.product_name ?? '', source: 'NPD Tracker', npdId: row.id, skus: [row.sku_code] });
  }
  return { products: [...products.values()].sort((a,b) => a.code.localeCompare(b.code)), warning: npd.error };
});

export async function requireFinishedGoodsMasterProduct(code: string): Promise<FinishedGoodsCostProduct> {
  const { products, warning } = await loadFinishedGoodsCostProducts();
  const product = products.find(p => p.code === code.trim().toUpperCase());
  if (!product) throw new Error(`Choose a product from the EasyEcom SKU master or NPD Tracker master.${warning ? ` ${warning}` : ''}`);
  return product;
}
