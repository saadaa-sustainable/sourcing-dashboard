import { createClient } from '@/lib/supabase/server';

/** Sprint-phase status of a feature. No row = 'live' (unlabelled/normal). */
export type FeatureStatusValue = 'live' | 'testing' | 'soon';

export type FeatureStatusRow = {
  feature_key: string;
  status: FeatureStatusValue;
  note: string | null;
  updated_by: string | null;
  updated_at: string | null;
};

export const FEATURE_STATUS_LABEL: Record<FeatureStatusValue, string> = {
  live: 'Live',
  testing: 'In Testing',
  soon: 'Coming Soon',
};

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
