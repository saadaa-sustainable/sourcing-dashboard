'use client';

import { canView } from '@/lib/views';
import type { SdRole } from '@/lib/forms/types';

export type MasterTab = {
  id: string;
  label: string;
  /** The original standalone route — used for the access check + help content. */
  route: string;
};

// Every master, in reading order. `route` is the legacy per-master page (kept
// reachable) and drives both the access check and the help panel.
export const MASTER_TABS: MasterTab[] = [
  { id: 'product', label: 'Product', route: '/product-master' },
  { id: 'category', label: 'Category', route: '/category-mapping' },
  { id: 'vendor', label: 'Vendor', route: '/vendor-master' },
  { id: 'fabric', label: 'Fabric', route: '/fabric-master' },
  { id: 'material', label: 'Material', route: '/material-master' },
  { id: 'fabric-cost', label: 'Fabric Cost', route: '/fabric-cost' },
];

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
