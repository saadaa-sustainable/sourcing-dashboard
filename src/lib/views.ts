/**
 * The views registry — every route a custom role can grant, grouped as the
 * sidebar groups them. Single source of truth for the User Panel's role editor,
 * the SideNav filter and the FormLayout access guard.
 *
 * Access model (see 20260901120000_custom_roles.sql):
 *  - base sd_user.role (viewer/team/admin) = approval ladder, unchanged;
 *  - custom roles carry `pages` (paths from this registry); a user's visible
 *    pages = union across their roles;
 *  - no custom roles -> unrestricted (today's behaviour); admins always see all;
 *  - admin-only routes stay admin-only — a custom role cannot grant them to a
 *    non-admin (the flags below are an AND with the role's page set).
 *  - '/' (the dashboard) is always visible: it is the landing/redirect target.
 */
export type ViewDef = {
  path: string;
  label: string;
  group: 'Workspace' | 'Workflows' | 'Data & Admin';
  adminOnly?: boolean;
};

export const ALL_VIEWS: ViewDef[] = [
  // Workspace — read-only analytical views.
  { path: '/replenishment', label: 'Replenishment', group: 'Workspace', adminOnly: true },
  { path: '/oos-calculation', label: 'OOS Calculation', group: 'Workspace' },
  { path: '/vendor-recommendation', label: 'Vendor Recommendation', group: 'Workspace' },
  { path: '/inward-plan', label: 'Inward Plan', group: 'Workspace' },
  // Workflows — operational pages.
  { path: '/buying-plan', label: 'Buying Plan', group: 'Workflows' },
  { path: '/standard-cost', label: 'Standard Cost', group: 'Workflows' },
  { path: '/vendor-capacity', label: 'Vendor Capacity', group: 'Workflows' },
  { path: '/po-approval', label: 'PO Approval', group: 'Workflows', adminOnly: true },
  { path: '/po-details', label: 'PO Details (Form)', group: 'Workflows' },
  { path: '/cutting-register', label: 'Cutting Register', group: 'Workflows' },
  { path: '/po-closure', label: 'PO Closure', group: 'Workflows' },
  { path: '/po-manual-adjustment', label: 'Manual Data Ingestion', group: 'Workflows' },
  { path: '/receivable-plan', label: 'Receivable Plan', group: 'Workflows' },
  { path: '/cash-flow', label: 'Cash Flow', group: 'Workflows', adminOnly: true },
  { path: '/discontinue', label: 'Discontinued Products View', group: 'Workflows' },
  { path: '/approvals', label: 'Approvals', group: 'Workflows', adminOnly: true },
  // Data & Admin — masters and datasets.
  { path: '/product-master', label: 'Product Master', group: 'Data & Admin' },
  { path: '/grn-detail', label: 'GRN Detail', group: 'Data & Admin' },
  { path: '/doq', label: 'DOQ Dataset', group: 'Data & Admin' },
  { path: '/vendor-master', label: 'Vendor Master', group: 'Data & Admin' },
  { path: '/fabric-master', label: 'Fabric Master', group: 'Data & Admin' },
  { path: '/material-master', label: 'Material Master', group: 'Data & Admin' },
  { path: '/fabric-cost', label: 'Fabric Cost', group: 'Data & Admin' },
  { path: '/users', label: 'User Panel', group: 'Data & Admin', adminOnly: true },
  { path: '/sync-status', label: 'Sync Health', group: 'Data & Admin' },
];

export const VIEW_GROUPS = ['Workspace', 'Workflows', 'Data & Admin'] as const;

/**
 * Can this user open `path`? allowedPages null/undefined = unrestricted.
 * Admin-only routes require the admin base role regardless of custom roles.
 */
export function canView(
  path: string,
  role: string,
  allowedPages: string[] | null | undefined,
): boolean {
  if (path === '/') return true;
  const def = ALL_VIEWS.find((v) => v.path === path);
  if (def?.adminOnly && role !== 'admin') return false;
  if (role === 'admin' || allowedPages == null) return true;
  return allowedPages.includes(path);
}
