'use client';

import { useState } from 'react';
import { ArrowUpRight, PackageSearch } from 'lucide-react';
import { FilterTable, type Column } from '@/components/filter-table';
import { InfoDot } from '@/components/info-dot';
import type { SourcingPoRow } from '@/lib/sourcing';

const fmt = new Intl.NumberFormat('en-IN', { maximumFractionDigits: 0 });
const date = (v: string | null) => (v ? String(v).slice(0, 10) : '—');

const COLS: Column<SourcingPoRow>[] = [
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
      r.tnaMissing ? (
        <span className="badge warn">No TNA</span>
      ) : (
        r.tnaStage
      ),
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

export function SourcingClient({ rows }: { rows: SourcingPoRow[] }) {
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
          columns={COLS}
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
