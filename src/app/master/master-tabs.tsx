'use client';

import { canView } from '@/lib/views';
import type { SdRole } from '@/lib/forms/types';
// The registry lives in a plain module — never export non-component values from
// this 'use client' file (the server page would receive a client-reference proxy).
import { MASTER_TABS } from './master-tabs.config';

export function MasterTabs({
  active,
  role,
  allowedPages,
}: {
  active: string;
  role: SdRole;
  allowedPages: string[] | null;
}) {
  // Only show the masters this user is allowed to see (custom-role page set).
  const visible = MASTER_TABS.filter((t) => canView(t.route, role, allowedPages));
  return (
    <div className="wf-plan-tabs" role="tablist" aria-label="Masters">
      {visible.map((t) => (
        <a
          key={t.id}
          href={`/master?tab=${t.id}`}
          role="tab"
          aria-selected={active === t.id}
          className={`wf-plan-tab${active === t.id ? ' active' : ''}`}
        >
          {t.label}
        </a>
      ))}
    </div>
  );
}
