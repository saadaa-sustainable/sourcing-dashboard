'use client';

import { useMemo } from 'react';
import { FilterTable, type Column } from '@/components/filter-table';
import type { ArrivalRow } from '@/lib/forms/queries-modules/inward-receivable';

const fmt = new Intl.NumberFormat('en-IN', { maximumFractionDigits: 0 });
const dateLabel = (v: string | null) =>
  v
    ? new Date(v).toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: '2-digit' })
    : '—';

const num = (v: number | null) => Number(v) || 0;

export function ArrivalsClient({ rows }: { rows: ArrivalRow[] }) {
  // Planned (team's Receivable-Plan expectation) vs actual (GRN receipts) across the view.
  const totals = useMemo(() => {
    let planned = 0;
    let actual = 0;
    for (const r of rows) {
      planned += num(r.expected_qty);
      actual += num(r.received_qty);
    }
    return { planned, actual, pct: planned > 0 ? Math.round((actual / planned) * 100) : null };
  }, [rows]);

  const columns: Column<ArrivalRow>[] = [
    {
      key: 'product_variant',
      label: 'Product',
      kind: 'mono',
      filter: 'text',
      accessor: (r) => r.product_variant ?? r.product_code ?? '—',
    },
    { key: 'category', label: 'Category', kind: 'text', filter: 'select', accessor: (r) => r.category ?? '—' },
    { key: 'vendor_name', label: 'Vendor', kind: 'text', filter: 'select', accessor: (r) => r.vendor_name ?? '—' },
    { key: 'po_ref_num', label: 'PO ref', kind: 'mono', accessor: (r) => r.po_ref_num ?? r.po_number ?? '—' },
    {
      key: 'expected_qty',
      label: 'Expected',
      kind: 'num',
      accessor: (r) => num(r.expected_qty),
      render: (r) => (r.expected_qty == null ? '—' : fmt.format(num(r.expected_qty))),
      info: 'Quantity the team expected this week (Receivable Plan).',
    },
    {
      key: 'expected_week',
      label: 'Expected week',
      kind: 'text',
      filter: 'select',
      accessor: (r) => r.expected_week ?? '',
      render: (r) => r.expected_week ?? '—',
      info: 'ISO week of the expected delivery date the team filled.',
    },
    {
      key: 'received_qty',
      label: 'Received',
      kind: 'num',
      accessor: (r) => num(r.received_qty),
      render: (r) => fmt.format(num(r.received_qty)),
      info: 'Quantity actually received against this PO + product (GRN Detail).',
    },
    {
      key: 'received_weeks',
      label: 'Received week(s)',
      kind: 'text',
      accessor: (r) => r.received_weeks ?? '',
      render: (r) => r.received_weeks ?? '—',
      info: 'ISO week(s) the goods actually landed (GRN created date).',
    },
    {
      key: 'variance',
      label: 'Variance',
      kind: 'num',
      accessor: (r) => num(r.variance),
      render: (r) =>
        r.variance == null ? '—' : `${r.variance > 0 ? '+' : ''}${fmt.format(r.variance)}`,
      info: 'Received − expected. Negative means short of plan.',
    },
    {
      key: 'status',
      label: 'Status',
      kind: 'text',
      filter: 'select',
      accessor: (r) => r.status || '—',
    },
  ];

  return (
    <>
      <div className="metric-grid compact">
        <div className="metric-card tone-purple">
          <span className="metric-label">Expected (Receivable Plan)</span>
          <strong>{fmt.format(totals.planned)}</strong>
        </div>
        <div className="metric-card tone-teal">
          <span className="metric-label">Received (GRN)</span>
          <strong>{fmt.format(totals.actual)}</strong>
        </div>
        <div className="metric-card tone-amber">
          <span className="metric-label">Received vs expected</span>
          <strong>{totals.pct == null ? '—' : `${totals.pct}%`}</strong>
        </div>
      </div>

      {rows.length ? (
        <FilterTable
          rows={rows}
          columns={columns}
          rowKey={(r) => r.row_key}
          defaultSource="supabase"
          unit="lines"
          searchPlaceholder="Product, vendor, PO ref…"
          emptyText="No arrival lines match your filters."
          download={{ filename: 'arrivals.csv' }}
        />
      ) : (
        <div className="panel" style={{ padding: 28 }}>
          <div className="empty-state">
            <p>
              No expected arrivals yet. As the team fills expected quantity and week in the Receivable
              Plan, arrivals show here against what GRN records as received.
            </p>
          </div>
        </div>
      )}
    </>
  );
}
