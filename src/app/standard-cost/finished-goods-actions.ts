'use server';

import { revalidatePath } from 'next/cache';
import { createAdminClient } from '@/lib/supabase/admin';
import { costWorkflowUser } from '@/lib/standard-cost-workflow.server';
import { requireFinishedGoodsMasterProduct } from '@/lib/finished-goods-cost.server';
import { loadNpdCostMasterOptions } from '@/lib/npd-tracker.server';

/** Revalidate master membership and create only the blank shell needed by the cost editor. */
export async function openFinishedGoodsCost(code: string) {
  try {
    const user = await costWorkflowUser(true);
    const product = await requireFinishedGoodsMasterProduct(code);
    const db = createAdminClient();
    if (product.source === 'NPD Tracker') {
      const row = (await loadNpdCostMasterOptions()).find(r => r.id === product.npdId);
      if (!row || row.blocked || row.code !== product.code) throw new Error('This NPD product changed. Refresh the product list.');
      const { data: registered, error: registryError } = await db.from('sd_temp_product').select('temp_code, status, npd_product_id').eq('npd_product_id', row.id).eq('status', 'active').maybeSingle();
      if (registryError) throw new Error(registryError.message);
      if (registered && registered.temp_code !== product.code) throw new Error(`This NPD product is already registered as ${registered.temp_code}.`);
      if (!registered) {
        const { error } = await db.from('sd_temp_product').insert({ temp_code: product.code, name: row.product_name, source: 'npd', status: 'active', npd_product_id: row.id, npd_item_code: row.item_code, npd_sku_code: row.sku_code, npd_category: row.category, npd_status: row.status, npd_product_type: row.product_type, created_by: user.email });
        if (error && error.code !== '23505') throw new Error(error.message);
        if (error) {
          const { data: winner } = await db.from('sd_temp_product').select('temp_code').eq('npd_product_id', row.id).eq('status', 'active').maybeSingle();
          if (winner?.temp_code !== product.code) throw new Error('This product code is registered to a different product.');
        }
      }
    }
    const { data: existing, error: readError } = await db.from('sd_standard_cost').select('hidden').eq('product_code', product.code).maybeSingle();
    if (readError) throw new Error(readError.message);
    if (!existing) {
      const { error } = await db.from('sd_standard_cost').upsert({ product_code: product.code, documented: false }, { onConflict: 'product_code', ignoreDuplicates: true });
      if (error) throw new Error(error.message);
    } else if (existing.hidden) {
      const { error: restoreError } = await db.from('sd_standard_cost').update({ hidden: false }).eq('product_code', product.code);
      if (restoreError) throw new Error(restoreError.message);
    }
    revalidatePath('/standard-cost');
    return { ok: true as const, href: `/standard-cost/${encodeURIComponent(product.code)}?edit=1` };
  } catch (error) {
    return { ok: false as const, error: error instanceof Error ? error.message : 'Could not open the product cost.' };
  }
}
