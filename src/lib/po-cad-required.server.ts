import type { SupabaseClient } from '@supabase/supabase-js';

/** Pending upload tickets and removed files never satisfy the CAD requirement. */
export async function requiredPoCadError(db: SupabaseClient, poId: number): Promise<string | null> {
  if (!Number.isSafeInteger(poId) || poId <= 0) return 'Save the Order step, then upload at least one CAD plan PDF in Cost.';
  const { count, error } = await db.from('sd_po_cad_document')
    .select('id', { count: 'exact', head: true })
    .eq('po_id', poId).is('removed_at', null).not('uploaded_at', 'is', null);
  if (error) return 'Could not verify CAD plans. Reload the PO and try again.';
  return count != null && count > 0 ? null : 'Upload at least one CAD plan PDF in Cost before continuing or submitting this PO.';
}
