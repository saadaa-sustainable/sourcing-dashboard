'use server';

import { revalidatePath } from 'next/cache';
import { createClient } from '@/lib/supabase/server';
import { currentUser } from '@/lib/forms/queries';
import { canEdit } from '@/lib/forms/approval';
import type { ActionResult } from '@/lib/forms/actions';

/**
 * Item 1 — set/clear a feature's sprint-phase status. Kept in its own 'use server'
 * file (not the concurrently-edited forms/actions.ts). Setting to 'live' deletes the
 * row so "live" stays the unlabelled default and the table only holds mid-rollout
 * features.
 */
export async function setFeatureStatus(formData: FormData): Promise<ActionResult> {
  const user = await currentUser();
  if (!user) return { ok: false, error: 'Not signed in.' };
  if (user.role !== 'admin') return { ok: false, error: 'Only an admin can set feature status.' };
  if (!canEdit(user.role, 'draft')) return { ok: false, error: 'No permission.' };

  const feature_key = String(formData.get('feature_key') ?? '').trim();
  const status = String(formData.get('status') ?? '').trim();
  const note = String(formData.get('note') ?? '').trim();
  if (!feature_key) return { ok: false, error: 'Feature key is required.' };
  if (!['live', 'testing', 'soon'].includes(status)) {
    return { ok: false, error: 'Status must be live, testing or soon.' };
  }

  const supabase = await createClient();
  if (status === 'live') {
    // Live is the unlabelled default — drop the row so the table stays a list of
    // only the mid-rollout features.
    const { error } = await supabase.from('sd_feature_status').delete().eq('feature_key', feature_key);
    if (error) return { ok: false, error: error.message };
  } else {
    const { error } = await supabase.from('sd_feature_status').upsert(
      { feature_key, status, note: note || null, updated_by: user.email, updated_at: new Date().toISOString() },
      { onConflict: 'feature_key' },
    );
    if (error) return { ok: false, error: error.message };
  }

  revalidatePath('/feature-status');
  return { ok: true, message: `Set ${feature_key} to ${status}.` };
}
