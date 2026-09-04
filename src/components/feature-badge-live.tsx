'use client';

import { useEffect, useState } from 'react';
import { FeatureBadge } from './feature-badge';
import type { FeatureStatusValue } from '@/lib/feature-status';

/**
 * Client wrapper that fetches this page's sprint-phase status from
 * /api/feature-status and renders the badge — keeps FormLayout client-safe (no
 * server-only import), so client components can use FormLayout too.
 */
export function FeatureBadgeLive({ path }: { path: string }) {
  const [state, setState] = useState<{ status?: FeatureStatusValue; note?: string | null } | null>(
    null,
  );

  useEffect(() => {
    let alive = true;
    fetch('/api/feature-status')
      .then((r) => (r.ok ? r.json() : null))
      .then((m) => {
        if (alive && m) setState(m[path] ?? null);
      })
      .catch(() => {});
    return () => {
      alive = false;
    };
  }, [path]);

  return <FeatureBadge status={state?.status} title={state?.note} />;
}
