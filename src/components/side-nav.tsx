'use client';

import { Fragment, useState, type ComponentType } from 'react';
import type { SdRole } from '@/lib/forms/types';
import { canView } from '@/lib/views';
import { useNavOverrides } from '@/components/nav-overrides';
import {
  Activity,
  UserX,
  Award,
  Ban,
  Boxes,
  CalendarClock,
  CheckCheck,
  ClipboardCheck,
  ClipboardList,
  Database,
  Factory,
  FileCheck,
  Handshake,
  FilePen,
  FileText,
  IndianRupee,
  LayoutDashboard,
  Menu,
  MessageSquare,
  PackageCheck,
  PackageSearch,
  PackageX,
  Repeat,
  ShoppingCart,
  SlidersHorizontal,
  Tags,
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
  /** Not in the sidebar by default (surfaced only when an admin turns it on). */
  defaultOff?: boolean;
};

// Sidebar groups, in the order the team asked for. Every href is still gated per user by
// canView (custom roles) and by the User Panel's show/hide overrides; the grouping is
// only where a link sits. Admin-only flags live in lib/views.ts.

// OVERVIEW — the entity one-pagers, each paired with the dashboard tab that tracks the
// same thing, plus the two dashboard tabs that have no page of their own.
const OVERVIEW_PAIRS: { page: NavLink; tab: TabId; tabLabel: string }[] = [
  { page: { href: '/po-360', label: 'PO Overview', Icon: FileCheck }, tab: 'open-po', tabLabel: 'PO Tracker' },
  { page: { href: '/product-360', label: 'Product Overview', Icon: PackageX }, tab: 'products', tabLabel: 'Product Tracker' },
  { page: { href: '/vendor-360', label: 'Vendor Overview', Icon: Factory }, tab: 'vendors', tabLabel: 'Vendor Performance' },
];
const OVERVIEW_TABS: TabId[] = ['merchants', 'matrix'];

// OPERATIONS — the day-to-day analytical views.
const OPERATIONS_LINKS: NavLink[] = [
  { href: '/ppm-prep', label: 'PPM Prep', Icon: CalendarClock },
  { href: '/replenishment', label: 'Replenishment', Icon: Repeat },
  { href: '/doq-dashboard', label: 'OOS Dashboard', Icon: CalendarClock },
  { href: '/oos-calculation', label: 'DOQ Calculation', Icon: PackageX },
  { href: '/vendor-recommendation', label: 'Vendor Recommendation', Icon: Award },
  { href: '/cost-analytics', label: 'Cost Analytics', Icon: IndianRupee },
  { href: '/vendor-otif', label: 'Vendor OTIF', Icon: Award },
  // Off by default (reachable from the bell); an admin can surface it via User Panel → Tabs.
  { href: '/feedback', label: 'Feedback & Issues', Icon: MessageSquare, defaultOff: true },
];

// PLANNING — decide the buy: cost baseline, capacity, the plan, the receipts.
const PLANNING_LINKS: NavLink[] = [
  { href: '/buying-plan', label: 'Buying Plan', Icon: ShoppingCart },
  { href: '/standard-cost', label: 'Standard Cost', Icon: IndianRupee },
  { href: '/vendor-capacity', label: 'Vendor Capacity', Icon: Factory },
  { href: '/receivable-plan', label: 'Inward Plan', Icon: PackageCheck },
];

// PO WORKFLOW — raise/approve → document → close out → pay.
const PO_WORKFLOW_LINKS: NavLink[] = [
  { href: '/po-approval', label: 'PO Approval', Icon: FileCheck },
  { href: '/po-details', label: 'PO Details (Form)', Icon: FileText },
  { href: '/po-closure', label: 'PO Closure', Icon: CheckCheck },
  { href: '/cash-flow', label: 'Cash Flow', Icon: Wallet },
];

// GOVERNANCE & DATA — the approval queue, data corrections, lifecycle exits, issues.
const GOVERNANCE_LINKS: NavLink[] = [
  { href: '/approvals', label: 'Approvals', Icon: ClipboardCheck },
  { href: '/po-manual-adjustment', label: 'Manual Data Ingestion', Icon: FilePen },
  { href: '/discontinue', label: 'Discontinued Products View', Icon: Ban },
  { href: '/issues', label: 'Issue Tracker', Icon: ClipboardList },
  { href: '/vendor-deboarding', label: 'Vendor De-Boarding', Icon: UserX },
];

// MASTER DATA & DATASETS — the Master hub, the raw datasets, and each master on its own
// (off by default because the hub holds them; an admin can surface any via User Panel → Tabs).
const MASTERS_LINKS: NavLink[] = [
  { href: '/master', label: 'Master', Icon: Tags },
  { href: '/grn-detail', label: 'GRN Detail', Icon: PackageCheck },
  { href: '/doq', label: 'DOQ Dataset', Icon: Database },
  { href: '/product-master', label: 'Product Master', Icon: Tags, defaultOff: true },
  { href: '/category-mapping', label: 'Category Mapping', Icon: Tags, defaultOff: true },
  { href: '/vendor-master', label: 'Vendor Master', Icon: Factory, defaultOff: true },
  { href: '/fabric-master', label: 'Fabric Master', Icon: Tags, defaultOff: true },
  { href: '/material-master', label: 'Material Master', Icon: Tags, defaultOff: true },
  { href: '/fabric-cost', label: 'Fabric Cost', Icon: IndianRupee, defaultOff: true },
];

// ADMIN — system administration.
const ADMIN_LINKS: NavLink[] = [
  { href: '/users', label: 'User Panel', Icon: UserCog },
  { href: '/adoption', label: 'Adoption & Activity', Icon: Activity },
  { href: '/rules-master', label: 'Rules Master', Icon: SlidersHorizontal },
  { href: '/feature-status', label: 'Feature Status', Icon: Activity },
  { href: '/sync-status', label: 'Sync Health', Icon: Activity },
];

// Whether a nav path is shown, given the global overrides and its built-in default.
export function navPathVisible(href: string, overrides: Record<string, boolean>, defaultOff = false): boolean {
  return overrides[href] ?? !defaultOff;
}

/** Flat list of every sidebar-manageable tab (base + surfaceable extras), for the
 *  User Panel → Tabs manager. `defaultOff` marks pages hidden unless turned on. */
export const NAV_ITEMS: { href: string; label: string; group: string; defaultOff: boolean }[] = [
  ...OVERVIEW_PAIRS.map((p) => ({ href: p.page.href, label: p.page.label, group: 'Overview', defaultOff: !!p.page.defaultOff })),
  ...OPERATIONS_LINKS.map((l) => ({ href: l.href, label: l.label, group: 'Operations', defaultOff: !!l.defaultOff })),
  ...PLANNING_LINKS.map((l) => ({ href: l.href, label: l.label, group: 'Planning', defaultOff: !!l.defaultOff })),
  ...PO_WORKFLOW_LINKS.map((l) => ({ href: l.href, label: l.label, group: 'PO Workflow', defaultOff: !!l.defaultOff })),
  ...GOVERNANCE_LINKS.map((l) => ({ href: l.href, label: l.label, group: 'Governance & Data', defaultOff: !!l.defaultOff })),
  ...MASTERS_LINKS.map((l) => ({ href: l.href, label: l.label, group: 'Master Data & Datasets', defaultOff: !!l.defaultOff })),
  ...ADMIN_LINKS.map((l) => ({ href: l.href, label: l.label, group: 'Admin', defaultOff: !!l.defaultOff })),
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
  // Global show/hide overrides come from context (root layout provides them).
  const navOverrides = useNavOverrides();
  const visible = (links: NavLink[]) =>
    links.filter((l) => navPathVisible(l.href, navOverrides, l.defaultOff) && canView(l.href, role, allowedPages));
  const tabVisible = (id: TabId) => canView(`tab:${id}`, role, allowedPages);
  const tabMeta = (id: TabId) => tabs.find(([tid]) => tid === id)!;
  // A divider renders only when the caller can see at least one item in the group.
  const groups: { title: string; links: NavLink[] }[] = [
    { title: 'Operations', links: visible(OPERATIONS_LINKS) },
    { title: 'Planning', links: visible(PLANNING_LINKS) },
    { title: 'PO Workflow', links: visible(PO_WORKFLOW_LINKS) },
    { title: 'Governance & Data', links: visible(GOVERNANCE_LINKS) },
    { title: 'Master Data & Datasets', links: visible(MASTERS_LINKS) },
    { title: 'Admin', links: visible(ADMIN_LINKS) },
  ];
  const overviewPairs = OVERVIEW_PAIRS.filter(
    (p) => (navPathVisible(p.page.href, navOverrides, p.page.defaultOff) && canView(p.page.href, role, allowedPages)) || tabVisible(p.tab),
  );
  const overviewTabs = OVERVIEW_TABS.filter(tabVisible);
  // A dashboard tab: a button on the dashboard itself (instant), a link from anywhere else.
  const renderTab = (id: TabId, labelOverride?: string, alt = false) => {
    const [, label, Icon] = tabMeta(id);
    const text = labelOverride ?? label;
    const cls = `${activeTab === id ? 'active' : ''}${alt ? ' nav-pair-alt' : ''}`.trim();
    return onTab ? (
      <button key={id} className={cls} onClick={() => { onTab(id); close(); }} title={text}>
        {!alt && <Icon size={18} />}
        <span>{text}</span>
      </button>
    ) : (
      <a key={id} href={`/?tab=${id}`} className={cls} onClick={close} title={text}>
        {!alt && <Icon size={18} />}
        <span>{text}</span>
      </a>
    );
  };
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
          <div className="wf-nav-divider">Dashboard</div>
          {/* My Dashboard — the role-specific landing view, always first. */}
          <a
            href="/my-dashboard"
            className={activeWorkflow === '/my-dashboard' ? 'active' : ''}
            onClick={close}
          >
            <Handshake size={18} />
            <span>My Dashboard</span>
          </a>
          {renderTab('dashboard')}

          {(overviewPairs.length > 0 || overviewTabs.length > 0) && (
            <div className="wf-nav-divider">Overview</div>
          )}
          {/* "PO Overview / PO Tracker": the one-pager and the dashboard tab that tracks the
              same thing share a row; both halves are links. */}
          {overviewPairs.map((p) => {
            const pageOk =
              navPathVisible(p.page.href, navOverrides, p.page.defaultOff) && canView(p.page.href, role, allowedPages);
            const tabOk = tabVisible(p.tab);
            return (
              <div className="nav-pair" key={p.page.href}>
                {pageOk ? renderLink(p.page) : renderTab(p.tab, p.tabLabel)}
                {pageOk && tabOk && (
                  <>
                    <span className="nav-pair-sep" aria-hidden="true">/</span>
                    {renderTab(p.tab, p.tabLabel, true)}
                  </>
                )}
              </div>
            );
          })}
          {overviewTabs.map((id) => renderTab(id))}

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
