'use client';

import { useMemo } from 'react';
import { FilterTable, type Column } from '@/components/filter-table';
import type { InwardPlanEntry } from '@/lib/forms/types';

type ArrivalRow = InwardPlanEntry & { category: string | null };

const fmt = new Intl.NumberFormat('en-IN', { maximumFractionDigits: 0 });
const monthLabel = (m: string | null) =>
  m
    ? new Date(`${m.slice(0, 10)}T00:00:00Z`).toLocaleDateString('en-IN', {
        month: 'short',
        year: 'numeric',
        timeZone: 'UTC',
      })
    : '—';
const dateLabel = (v: string | null) =>
  v
    ? new Date(v).toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: '2-digit' })
    : '—';

const num = (v: number | null) => Number(v) || 0;

export function ArrivalsClient({ rows }: { rows: ArrivalRow[] }) {
  // Overall planned-vs-actual across everything in view (the table filters below).
  const totals = useMemo(() => {
    let planned = 0;
    let actual = 0;
    for (const r of rows) {
      planned += num(r.inward_qty);
      actual += num(r.actual_inward_qty);
    }
    return { planned, actual, pct: planned > 0 ? Math.round((actual / planned) * 100) : null };
  }, [rows]);

  const columns: Column<ArrivalRow>[] = [
    { key: 'product_code', label: 'Product', kind: 'mono', filter: 'text' },
    { key: 'category', label: 'Category', kind: 'text', filter: 'select', accessor: (r) => r.category ?? '—' },
    { key: 'vendor_name', label: 'Vendor', kind: 'text', filter: 'select', accessor: (r) => r.vendor_name ?? '—' },
    { key: 'po_no', label: 'PO no.', kind: 'mono', accessor: (r) => r.po_no ?? '—' },
    {
      key: 'plan_month',
      label: 'Plan month',
      kind: 'text',
      filter: 'select',
      accessor: (r) => r.plan_month,
      render: (r) => monthLabel(r.plan_month),
    },
    {
      key: 'expected_delivery_date',
      label: 'EDD',
      kind: 'text',
      accessor: (r) => r.expected_delivery_date ?? '',
      render: (r) => dateLabel(r.expected_delivery_date),
      info: 'Expected delivery date from the PO itself.',
    },
    {
      key: 'po_closure_date',
      label: 'PO closure',
      kind: 'text',
      accessor: (r) => r.po_closure_date ?? '',
      render: (r) => dateLabel(r.po_closure_date),
      info: 'Date the PO closed/completed. Blank until it completes.',
    },
    {
      key: 'inward_qty',
      label: 'Planned',
      kind: 'num',
      accessor: (r) => num(r.inward_qty),
      render: (r) => fmt.format(num(r.inward_qty)),
      info: 'Monthly approved inward quantity.',
    },
    {
      key: 'actual_inward_qty',
      label: 'Actual',
      kind: 'num',
      accessor: (r) => num(r.actual_inward_qty),
      render: (r) => (r.actual_inward_qty == null ? '—' : fmt.format(num(r.actual_inward_qty))),
      info: 'What actually arrived (filled as the month closes).',
    },
    {
      key: 'approval_status',
      label: 'Status',
      kind: 'text',
      filter: 'select',
      accessor: (r) => r.approval_status || '—',
    },
  ];

  return (
    <>
      <div className="metric-grid compact">
        <div className="metric-card tone-purple">
          <span className="metric-label">Planned (approved inward)</span>
          <strong>{fmt.format(totals.planned)}</strong>
        </div>
        <div className="metric-card tone-teal">
          <span className="metric-label">Actual arrived</span>
          <strong>{fmt.format(totals.actual)}</strong>
        </div>
        <div className="metric-card tone-amber">
          <span className="metric-label">Received vs planned</span>
          <strong>{totals.pct == null ? '—' : `${totals.pct}%`}</strong>
        </div>
      </div>

      {rows.length ? (
        <FilterTable
          rows={rows}
          columns={columns}
          rowKey={(r) => String(r.id)}
          unit="lines"
          searchPlaceholder="Product, vendor, PO…"
          emptyText="No arrival lines match your filters."
          download={{ filename: 'arrivals.csv' }}
        />
      ) : (
        <div className="panel" style={{ padding: 28 }}>
          <div className="empty-state">
            <p>No inward-plan lines yet. As the team fills the monthly inward plan, arrivals show here.</p>
          </div>
        </div>
      )}
    </>
  );
}
