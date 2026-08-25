'use client';

import { useState, type ComponentType } from 'react';
import {
  Activity,
  Award,
  Ban,
  Boxes,
  CalendarClock,
  ClipboardCheck,
  Factory,
  FileCheck,
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
  ['dashboard', 'Dashboard', LayoutDashboard],
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

const WORKFLOW_LINKS: NavLink[] = [
  { href: '/buying-plan', label: 'Buying Plan', Icon: ShoppingCart },
  { href: '/replenishment', label: 'Replenishment', Icon: Repeat },
  { href: '/oos-calculation', label: 'OOS Calculation', Icon: PackageX },
  { href: '/standard-cost', label: 'Standard Cost', Icon: IndianRupee },
  { href: '/vendor-capacity', label: 'Vendor Capacity', Icon: Factory },
  { href: '/vendor-recommendation', label: 'Vendor Recommendation', Icon: Award },
  { href: '/po-approval', label: 'PO Approval', Icon: FileCheck },
  { href: '/po-details', label: 'PO Details (Form)', Icon: FileText },
  { href: '/po-manual-adjustment', label: 'Manual Data Ingestion', Icon: FilePen },
  { href: '/inward-plan', label: 'Inward Plan', Icon: Truck },
  { href: '/receivable-plan', label: 'Receivable Plan', Icon: PackageCheck },
  { href: '/cash-flow', label: 'Cash Flow', Icon: Wallet },
  { href: '/discontinue', label: 'Discontinued Products View', Icon: Ban },
  { href: '/approvals', label: 'Approvals', Icon: ClipboardCheck },
];

/**
 * The shared left sidebar. Two modes:
 *  - Dashboard: pass `onTab` + `activeTab` — main items are buttons (instant SPA).
 *  - Any other page (workflow forms): omit `onTab` — main items link to /?tab=<id>,
 *    and `activeWorkflow` highlights the current form.
 */
export function SideNav({
  activeTab,
  onTab,
  activeWorkflow,
  userEmail,
}: {
  activeTab?: TabId;
  onTab?: (id: TabId) => void;
  activeWorkflow?: string;
  userEmail: string | null;
}) {
  const [navOpen, setNavOpen] = useState(false);
  const close = () => setNavOpen(false);
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
          {tabs
            .filter(([id]) => id !== 'urgent-replenish')
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
          <div className="wf-nav-divider">Workflows</div>
          {WORKFLOW_LINKS.map(({ href, label, Icon, external }) => (
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
          ))}
          <div className="wf-nav-divider">Admin</div>
          <a
            href="/product-master"
            className={activeWorkflow === '/product-master' ? 'active' : ''}
            onClick={close}
          >
            <Tags size={18} />
            <span>Product Master</span>
          </a>
          <a
            href="/fabric-master"
            className={activeWorkflow === '/fabric-master' ? 'active' : ''}
            onClick={close}
          >
            <Layers size={18} />
            <span>Fabric Master</span>
          </a>
          <a
            href="/material-master"
            className={activeWorkflow === '/material-master' ? 'active' : ''}
            onClick={close}
          >
            <Boxes size={18} />
            <span>Material Master</span>
          </a>
          <a
            href="/fabric-cost"
            className={activeWorkflow === '/fabric-cost' ? 'active' : ''}
            onClick={close}
          >
            <IndianRupee size={18} />
            <span>Fabric Cost</span>
          </a>
          <a
            href="/users"
            className={activeWorkflow === '/users' ? 'active' : ''}
            onClick={close}
          >
            <UserCog size={18} />
            <span>User Panel</span>
          </a>
          <a
            href="/sync-status"
            className={activeWorkflow === '/sync-status' ? 'active' : ''}
            onClick={close}
          >
            <Activity size={18} />
            <span>Sync Health</span>
          </a>
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
