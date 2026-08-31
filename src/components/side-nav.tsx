'use client';

import { useState, type ComponentType } from 'react';
import type { SdRole } from '@/lib/forms/types';
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
  adminOnly?: boolean;
};

// Read-only analytical views. They're separate routes (not the SPA tabs above),
// but they're just information to look at — so they belong in the Workspace
// section with the dashboards, not among the operational Workflows below.
const WORKSPACE_LINKS: NavLink[] = [
  { href: '/replenishment', label: 'Replenishment', Icon: Repeat, adminOnly: true },
  { href: '/oos-calculation', label: 'OOS Calculation', Icon: PackageX },
  { href: '/vendor-recommendation', label: 'Vendor Recommendation', Icon: Award },
  { href: '/inward-plan', label: 'Inward Plan', Icon: Truck },
];

// Operational pages: each one you DO something on — build a plan, submit a form,
// approve, ingest data, set terms (all back a server action that writes).
const WORKFLOW_LINKS: NavLink[] = [
  { href: '/buying-plan', label: 'Buying Plan', Icon: ShoppingCart },
  { href: '/standard-cost', label: 'Standard Cost', Icon: IndianRupee },
  { href: '/vendor-capacity', label: 'Vendor Capacity', Icon: Factory },
  { href: '/po-approval', label: 'PO Approval', Icon: FileCheck, adminOnly: true },
  { href: '/po-details', label: 'PO Details (Form)', Icon: FileText },
  { href: '/cutting-register', label: 'Cutting Register', Icon: Scissors },
  { href: '/po-closure', label: 'PO Closure', Icon: CheckCheck },
  { href: '/po-manual-adjustment', label: 'Manual Data Ingestion', Icon: FilePen },
  { href: '/receivable-plan', label: 'Receivable Plan', Icon: PackageCheck },
  { href: '/cash-flow', label: 'Cash Flow', Icon: Wallet, adminOnly: true },
  { href: '/discontinue', label: 'Discontinued Products View', Icon: Ban },
  { href: '/approvals', label: 'Approvals', Icon: ClipboardCheck, adminOnly: true },
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
  role = 'viewer',
}: {
  activeTab?: TabId;
  onTab?: (id: TabId) => void;
  activeWorkflow?: string;
  userEmail: string | null;
  role?: SdRole;
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
          {WORKSPACE_LINKS.filter(({ adminOnly }) => !adminOnly || role === 'admin').map(
            ({ href, label, Icon }) => (
              <a
                key={href}
                href={href}
                className={activeWorkflow === href ? 'active' : ''}
                onClick={close}
              >
                <Icon size={18} />
                <span>{label}</span>
              </a>
            ),
          )}
          <div className="wf-nav-divider">Workflows</div>
          {WORKFLOW_LINKS.filter(({ adminOnly }) => !adminOnly || role === 'admin').map(
            ({ href, label, Icon, external }) => (
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
            href="/grn-detail"
            className={activeWorkflow === '/grn-detail' ? 'active' : ''}
            onClick={close}
          >
            <PackageCheck size={18} />
            <span>GRN Detail</span>
          </a>
          <a
            href="/doq"
            className={activeWorkflow === '/doq' ? 'active' : ''}
            onClick={close}
          >
            <Database size={18} />
            <span>DOQ Dataset</span>
          </a>
          <a
            href="/vendor-master"
            className={activeWorkflow === '/vendor-master' ? 'active' : ''}
            onClick={close}
          >
            <Factory size={18} />
            <span>Vendor Master</span>
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
