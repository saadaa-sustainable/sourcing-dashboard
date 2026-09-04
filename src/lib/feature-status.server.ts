import { createClient } from '@/lib/supabase/server';
import type { FeatureStatusRow } from './feature-status';

// The type + label constants moved to the client-safe ./feature-status so client
// components (FeatureBadge, FormLayout) don't pull this server-only module (and
// next/headers) into the client bundle. Re-exported here for server importers.
export { FEATURE_STATUS_LABEL } from './feature-status';
export type { FeatureStatusValue, FeatureStatusRow } from './feature-status';

/**
 * Item 1 — all feature statuses keyed by feature_key (a lib/views.ts path). Small
 * table; safe to load per page render. Only non-'live' rows carry a visible badge,
 * so callers can skip a badge when the key is absent or 'live'.
 */
export async function loadFeatureStatuses(): Promise<Record<string, FeatureStatusRow>> {
  try {
    const supabase = await createClient();
    const { data } = await supabase
      .from('sd_feature_status')
      .select('feature_key, status, note, updated_by, updated_at');
    const out: Record<string, FeatureStatusRow> = {};
    for (const r of (data ?? []) as FeatureStatusRow[]) out[r.feature_key] = r;
    return out;
  } catch {
    return {};
  }
}
