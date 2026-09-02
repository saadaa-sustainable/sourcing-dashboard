'use client';

import { useState } from 'react';
import Link from 'next/link';
import { ArrowUpRight, PackageSearch, AlertTriangle, Inbox, Send } from 'lucide-react';
import { FilterTable, type Column } from '@/components/filter-table';
import { InfoDot } from '@/components/info-dot';
import { StatusBadge } from '@/components/forms/form-layout';
import type { SourcingPoRow } from '@/lib/sourcing';
import type { MyDashboardData, MySubmission, ApprovalQueueItem } from '@/lib/forms/types';

export type RoleViewId = 'sourcing';

const fmt = new Intl.NumberFormat('en-IN', { maximumFractionDigits: 0 });
const date = (v: string | null) => (v ? String(v).slice(0, 10) : '—');
const when = (v: string | null) =>
  v ? new Date(v).toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: 'numeric' }) : '—';

/* ---------------- Sourcing view: open-PO card → PO table ---------------- */

const SOURCING_COLS: Column<SourcingPoRow>[] = [
  { key: 'poNumber', label: 'PO No.', kind: 'mono' },
  {
    key: 'vendorName',
    label: 'Vendor',
    kind: 'text',
    filter: 'select',
    accessor: (r) => `${r.vendorName} ${r.vendorCode}`,
    render: (r) => (
      <>
        {r.vendorName}
        <small>{r.vendorCode}</small>
      </>
    ),
    info: 'Vendor producing this PO, with its vendor code.',
  },
  {
    key: 'merchant',
    label: 'Merchandiser',
    kind: 'text',
    filter: 'select',
    info: 'The merchandiser who manages this vendor.',
  },
  {
    key: 'totalQty',
    label: 'Total Qty',
    kind: 'num',
    accessor: (r) => r.totalQty,
    render: (r) => (
      <>
        <strong>{fmt.format(r.totalQty)}</strong>
        <small>{fmt.format(r.pendingQty)} pending</small>
      </>
    ),
    info: 'Total ordered quantity across all lines of the PO; below it, the quantity still pending.',
  },
  {
    key: 'tnaStage',
    label: 'TNA',
    kind: 'text',
    filter: 'select',
    render: (r) =>
      r.tnaMissing ? <span className="badge warn">No TNA</span> : r.tnaStage,
    info: 'Current production stage — the earliest TNA stage without an actual date. "No TNA" means no timeline has been entered for this PO.',
  },
  {
    key: 'edd',
    label: 'EDD',
    kind: 'text',
    accessor: (r) => date(r.edd),
    render: (r) => (
      <>
        {date(r.edd)}
        {r.delayDays > 0 && (
          <span className="badge danger" style={{ marginLeft: 8 }}>
            {fmt.format(r.delayDays)}d late
          </span>
        )}
      </>
    ),
    info: 'Earliest expected delivery date across the PO’s lines; flagged when already past due.',
  },
];

function SourcingView({ rows }: { rows: SourcingPoRow[] }) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <div className="metric-grid compact">
        <div
          className="metric-card tone-amber clickable"
          role="button"
          tabIndex={0}
          onClick={() => setOpen((o) => !o)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' || e.key === ' ') {
              e.preventDefault();
              setOpen((o) => !o);
            }
          }}
        >
          <span className="metric-head">
            <span className="metric-head-left">
              <span className="metric-icon">
                <PackageSearch size={13} strokeWidth={2} />
              </span>
              <span className="metric-label">Open POs</span>
            </span>
            <InfoDot
              text="Purchase orders that are approved and not yet completed. Click to see the full list with vendor, merchandiser, quantity, TNA stage and EDD."
              label="About Open POs"
            />
          </span>
          <strong>{fmt.format(rows.length)}</strong>
          <small>{open ? 'Click to hide the PO list' : 'Click to view the PO list'}</small>
          <ArrowUpRight className="metric-action" size={15} />
        </div>
      </div>
      {open && (
        <FilterTable
          rows={rows}
          columns={SOURCING_COLS}
          rowKey={(r) => r.poNumber}
          unit="POs"
          searchPlaceholder="PO, vendor, code or merchandiser"
          emptyText="No open POs match your filters."
          rowClass={(r) => (r.delayDays > 0 ? 'wf-row-over' : undefined)}
        />
      )}
    </>
  );
}

/* -------- Persistent Rework notice: my submissions bounced back -------- */

/**
 * Un-dismissable list of the current user's own records sent back for rework.
 * Stays put — above the tabs — until the submitter fixes and re-submits them,
 * so a bounced plan can't be silently missed.
 */
function ReworkNotice({ items }: { items: MySubmission[] }) {
  if (!items.length) return null;
  return (
    <div className="wf-rework-notice" role="alert">
      <div className="wf-rework-head">
        <AlertTriangle size={15} strokeWidth={2.2} />
        <strong>
          {items.length} of your submission{items.length > 1 ? 's were' : ' was'} sent back for
          rework
        </strong>
      </div>
      <ul className="wf-rework-list">
        {items.map((r) => (
          <li key={`${r.entityType}-${r.entityId}`}>
            <div className="wf-rework-row">
              <Link href={r.href} className="wf-rework-link">
                {r.label}
              </Link>
              <span className="wf-subtle">
                {r.reworkedBy ? `by ${r.reworkedBy}` : ''}
                {r.reworkedAt ? ` · ${when(r.reworkedAt)}` : ''}
              </span>
            </div>
            {r.reworkNotes && <p className="wf-rework-remark">“{r.reworkNotes}”</p>}
          </li>
        ))}
      </ul>
    </div>
  );
}

/* ------------------- Approvals view: my personal queue ------------------- */

function ApprovalsView({
  approvals,
  submissions,
}: {
  approvals: ApprovalQueueItem[];
  submissions: MySubmission[];
}) {
  return (
    <div className="wf-my-approvals">
      <section>
        <h3 className="wf-section-title">
          <Inbox size={14} strokeWidth={2} /> Awaiting your approval ({approvals.length})
        </h3>
        {approvals.length ? (
          <ul className="wf-mini-queue">
            {approvals.map((item) => (
              <li key={`${item.entityType}-${item.entityId}`}>
                <div className="wf-mini-main">
                  <Link href="/approvals" className="wf-rework-link">
                    {item.label}
                  </Link>
                  <span className="wf-subtle">{item.sublabel}</span>
                </div>
                <div className="wf-mini-meta">
                  <StatusBadge status={item.status} />
                  <span className="wf-subtle">
                    {item.submittedBy ? `from ${item.submittedBy}` : ''}
                  </span>
                </div>
              </li>
            ))}
          </ul>
        ) : (
          <p className="wf-subtle wf-empty-line">Nothing is waiting on you right now.</p>
        )}
      </section>

      <section>
        <h3 className="wf-section-title">
          <Send size={14} strokeWidth={2} /> Your submissions ({submissions.length})
        </h3>
        {submissions.length ? (
          <ul className="wf-mini-queue">
            {submissions.map((s) => (
              <li key={`${s.entityType}-${s.entityId}`}>
                <div className="wf-mini-main">
                  <Link href={s.href} className="wf-rework-link">
                    {s.label}
                  </Link>
                  <span className="wf-subtle">Submitted {when(s.submittedAt)}</span>
                </div>
                <div className="wf-mini-meta">
                  <StatusBadge status={s.status} />
                </div>
              </li>
            ))}
          </ul>
        ) : (
          <p className="wf-subtle wf-empty-line">You have no submissions in flight.</p>
        )}
      </section>
    </div>
  );
}

/* ------------------------- My Dashboard shell ------------------------- */

type TabId = 'approvals' | RoleViewId;

export function MyDashboardClient({
  views,
  sourcingRows,
  my,
}: {
  views: { id: RoleViewId; label: string }[];
  sourcingRows: SourcingPoRow[];
  my: MyDashboardData;
}) {
  // The Approvals tab is personal and always present; role views follow it.
  const tabs: { id: TabId; label: string }[] = [
    { id: 'approvals', label: 'Approvals' },
    ...views,
  ];
  const [active, setActive] = useState<TabId>('approvals');

  return (
    <>
      {/* Persistent, un-dismissable — visible on every tab. */}
      <ReworkNotice items={my.rework} />

      <div className="role-tabs" role="tablist" aria-label="My Dashboard views">
        {tabs.map((v) => (
          <button
            key={v.id}
            role="tab"
            aria-selected={active === v.id}
            className={active === v.id ? 'active' : ''}
            onClick={() => setActive(v.id)}
          >
            {v.label}
            {v.id === 'approvals' && my.approvals.length > 0 && (
              <span className="role-tab-count">{my.approvals.length}</span>
            )}
          </button>
        ))}
      </div>

      {active === 'approvals' && (
        <ApprovalsView approvals={my.approvals} submissions={my.submissions} />
      )}
      {active === 'sourcing' && <SourcingView rows={sourcingRows} />}
    </>
  );
}
