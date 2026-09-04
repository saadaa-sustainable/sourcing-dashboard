/**
 * Client-safe feature-status constants + types (item 1, sprint-phase labels).
 *
 * Kept separate from feature-status.server.ts (which imports the Supabase server
 * client → next/headers) so client components — FeatureBadge, FormLayout — can
 * use the type/label without pulling server-only code into the client bundle.
 */

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
