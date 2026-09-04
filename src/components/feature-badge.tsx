import { FEATURE_STATUS_LABEL, type FeatureStatusValue } from '@/lib/feature-status.server';

/**
 * Item 1 — sprint-phase badge. Live features are unlabelled (returns null), so only
 * mid-rollout features carry a visible "In Testing" / "Coming Soon" tag. Pure
 * presentational; usable in server or client components.
 */
export function FeatureBadge({
  status,
  title,
}: {
  status: FeatureStatusValue | null | undefined;
  title?: string | null;
}) {
  if (!status || status === 'live') return null;
  return (
    <span className={`feature-badge is-${status}`} title={title ?? undefined}>
      {FEATURE_STATUS_LABEL[status]}
    </span>
  );
}
