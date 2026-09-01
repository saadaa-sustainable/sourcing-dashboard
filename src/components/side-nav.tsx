'use client';

import { Fragment, useState, type ComponentType } from 'react';
import type { SdRole } from '@/lib/forms/types';
import { canView } from '@/lib/views';
import {
  Activity,
  Award,
  Ban,
  Boxes,
  CalendarClock,
  CheckCheck,
  ClipboardCheck,
  Database,
  Factory,
  FileCheck,
  Handshake,
  FilePen,
  FileText,
  IndianRupee,
  Layers,
  LayoutDashboard,
  Menu,
  PackageCheck,
  PackageSearch,
  PackageX,
  Repeat,
  Scissors,
  ShoppingCart,
  Tags,
  Truck,
  UserCog,
  Wallet,
  Users,
  X,
  Zap,
} from 'lucide-react';

// The dashboard's main tabs. These are in-page state on `/` (not routes), so the
// sidebar switches them via `onTab` on the dashboard, and links to `/?tab=<id>`
// from anywhere else. Shared with dashboard-shell.tsx.
export const tabs = [
  ['dashboard', 'Main Dashboard', LayoutDashboard],
  ['open-po', 'Open PO Tracker', PackageSearch],
  ['vendors', 'Vendor Performance', Factory],
  ['merchants', 'Merchant Performance', Users],
  ['products', 'Product Tracker', Boxes],
  ['urgent-replenish', 'Urgent Replenishment', Zap],
  ['matrix', 'Product Matrix View', CalendarClock],
] as const;

export type TabId = (typeof tabs)[number][0];

type NavLink = {
  href: string;
  label: string;
  Icon: ComponentType<{ size?: number }>;
  external?: boolean;
};

// Read-only analytical views. They're separate routes (not the SPA tabs above),
// but they're just information to look at — so they belong in the Workspace
// section with the dashboards, not among the operational Workflows below.
// Admin-only flags live in the views registry (lib/views.ts) — canView applies
// them together with the caller's custom-role page set.
const WORKSPACE_LINKS: NavLink[] = [
  { href: '/replenishment', label: 'Replenishment', Icon: Repeat },
  { href: '/oos-calculation', label: 'OOS Calculation', Icon: PackageX },
  { href: '/vendor-recommendation', label: 'Vendor Recommendation', Icon: Award },
  { href: '/inward-plan', label: 'Inward Plan', Icon: Truck },
];

// Operational pages, grouped by use case (DAM nav model: chronological
// workflow sections, then masters, then system). Regrouping is cosmetic —
// role gating stays per-href via canView.

// Decide the buy: cost baseline, capacity check, the plan itself.
const PLANNING_LINKS: NavLink[] = [
  { href: '/buying-plan', label: 'Buying Plan', Icon: ShoppingCart },
  { href: '/standard-cost', label: 'Standard Cost', Icon: IndianRupee },
  { href: '/vendor-capacity', label: 'Vendor Capacity', Icon: Factory },
];

// The PO lifecycle in order: raise/approve → document → plan receipts →
// production (cutting) → close out → pay.
const PO_WORKFLOW_LINKS: NavLink[] = [
  { href: '/po-approval', label: 'PO Approval', Icon: FileCheck },
  { href: '/po-details', label: 'PO Details (Form)', Icon: FileText },
  { href: '/receivable-plan', label: 'Receivable Plan', Icon: PackageCheck },
  { href: '/cutting-register', label: 'Cutting Register', Icon: Scissors },
  { href: '/po-closure', label: 'PO Closure', Icon: CheckCheck },
  { href: '/cash-flow', label: 'Cash Flow', Icon: Wallet },
];

// Cross-cutting governance: the approval queue, data corrections, lifecycle exits.
const GOVERNANCE_LINKS: NavLink[] = [
  { href: '/approvals', label: 'Approvals', Icon: ClipboardCheck },
  { href: '/po-manual-adjustment', label: 'Manual Data Ingestion', Icon: FilePen },
  { href: '/discontinue', label: 'Discontinued Products View', Icon: Ban },
];

// Reference data the workflows read from.
const MASTERS_LINKS: NavLink[] = [
  { href: '/product-master', label: 'Product Master', Icon: Tags },
  { href: '/vendor-master', label: 'Vendor Master', Icon: Factory },
  { href: '/fabric-master', label: 'Fabric Master', Icon: Layers },
  { href: '/material-master', label: 'Material Master', Icon: Boxes },
  { href: '/fabric-cost', label: 'Fabric Cost', Icon: IndianRupee },
  { href: '/grn-detail', label: 'GRN Detail', Icon: PackageCheck },
  { href: '/doq', label: 'DOQ Dataset', Icon: Database },
];

// System administration.
const ADMIN_LINKS: NavLink[] = [
  { href: '/users', label: 'User Panel', Icon: UserCog },
  { href: '/sync-status', label: 'Sync Health', Icon: Activity },
];

/**
 * The shared left sidebar. Two modes:
 *  - Dashboard: pass `onTab` + `activeTab` — main items are buttons (instant SPA).
 *  - Any other page (workflow forms): omit `onTab` — main items link to /?tab=<id>,
 *    and `activeWorkflow` highlights the current form.
 * `allowedPages` (from the caller's custom roles; null = unrestricted) filters
 * every route link. The dashboard tabs always show — '/' is the landing page.
 */
export function SideNav({
  activeTab,
  onTab,
  activeWorkflow,
  userEmail,
  role = 'viewer',
  allowedPages = null,
}: {
  activeTab?: TabId;
  onTab?: (id: TabId) => void;
  activeWorkflow?: string;
  userEmail: string | null;
  role?: SdRole;
  allowedPages?: string[] | null;
}) {
  const [navOpen, setNavOpen] = useState(false);
  const close = () => setNavOpen(false);
  const visible = (links: NavLink[]) =>
    links.filter(({ href }) => canView(href, role, allowedPages));
  const workspace = visible(WORKSPACE_LINKS);
  // Use-case sections below the Workspace block; a divider renders only when
  // the caller can see at least one page in the group.
  const groups: { title: string; links: NavLink[] }[] = [
    { title: 'Planning', links: visible(PLANNING_LINKS) },
    { title: 'PO Workflow', links: visible(PO_WORKFLOW_LINKS) },
    { title: 'Governance & Data', links: visible(GOVERNANCE_LINKS) },
    { title: 'Masters & Datasets', links: visible(MASTERS_LINKS) },
    { title: 'Admin', links: visible(ADMIN_LINKS) },
  ];
  const renderLink = ({ href, label, Icon, external }: NavLink) => (
    <a
      key={href}
      href={href}
      target={external ? '_blank' : undefined}
      rel={external ? 'noopener noreferrer' : undefined}
      className={!external && activeWorkflow === href ? 'active' : ''}
      onClick={close}
    >
      <Icon size={18} />
      <span>{label}</span>
    </a>
  );
  return (
    <>
      <button
        className="menu-button sidebar-toggle"
        aria-label="Open navigation"
        onClick={() => setNavOpen(true)}
      >
        <Menu />
      </button>
      <aside className={navOpen ? 'sidebar open' : 'sidebar'}>
        <div className="brand">
          <div className="brand-mark">S</div>
          <div>
            <strong>SAADAA</strong>
            <span>Sourcing intelligence</span>
          </div>
          <button className="mobile-close" aria-label="Close navigation" onClick={close}>
            <X />
          </button>
        </div>
        <nav>
          {/* My Dashboard — the role-specific landing view, always first. */}
          <a
            href="/my-dashboard"
            className={activeWorkflow === '/my-dashboard' ? 'active' : ''}
            onClick={close}
          >
            <Handshake size={18} />
            <span>My Dashboard</span>
          </a>
          {tabs
            .filter(([id]) => id !== 'urgent-replenish')
            .filter(([id]) => canView(`tab:${id}`, role, allowedPages))
            .map(([id, label, Icon]) =>
              onTab ? (
                <button
                  key={id}
                  className={activeTab === id ? 'active' : ''}
                  onClick={() => {
                    onTab(id);
                    close();
                  }}
                >
                  <Icon size={18} />
                  <span>{label}</span>
                </button>
              ) : (
                <a key={id} href={`/?tab=${id}`} onClick={close}>
                  <Icon size={18} />
                  <span>{label}</span>
                </a>
              ),
            )}
          {workspace.map(renderLink)}
          {groups.map(({ title, links }) =>
            links.length > 0 ? (
              <Fragment key={title}>
                <div className="wf-nav-divider">{title}</div>
                {links.map(renderLink)}
              </Fragment>
            ) : null,
          )}
        </nav>
        <div className="sidebar-foot">
          <div className="status-dot">
            <i />
            Data connected
          </div>
          <small>{userEmail ?? 'Local fixture mode'}</small>
        </div>
      </aside>
    </>
  );
}
