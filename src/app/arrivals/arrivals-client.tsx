'use client';

import { useMemo, useState } from 'react';
import { FilterTable, type Column } from '@/components/filter-table';
import type { ArrivalRow } from '@/lib/forms/queries-modules/inward-receivable';

const fmt = new Intl.NumberFormat('en-IN', { maximumFractionDigits: 0 });
const dateLabel = (v: string | null) =>
  v
    ? new Date(v).toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: '2-digit' })
    : '—';

const num = (v: number | null) => Number(v) || 0;

export function ArrivalsClient({ rows }: { rows: ArrivalRow[] }) {
  // The headline cards follow the table's filters (month / vendor / source…), so a
  // filtered month shows that month's expected vs received, not the all-time totals.
  const [visible, setVisible] = useState<ArrivalRow[]>(rows);
  const totals = useMemo(() => {
    let planned = 0;
    let actual = 0;
    for (const r of visible) {
      planned += num(r.expected_qty);
      actual += num(r.received_qty);
    }
    return { planned, actual, pct: planned > 0 ? Math.round((actual / planned) * 100) : null };
  }, [visible]);

  const columns: Column<ArrivalRow>[] = [
    {
      key: 'source',
      source: 'computed',
      label: 'Source',
      kind: 'text',
      filter: 'select',
      accessor: (r) => (r.source === 'history' ? 'Approved plan (history)' : 'Live plan'),
    },
    {
      key: 'expected_month',
      source: 'computed',
      label: 'Month',
      kind: 'text',
      filter: 'select',
      accessor: (r) => r.expected_month ?? '—',
      info: "WHAT: the month the goods were planned to arrive in.\n\nHOW: from the Inward Plan entry (week or month).\n\nUSE: pick a month to see what was planned for it and what actually landed.",
    },
    {
      key: 'product_variant',
      source: 'easyecom',
      label: 'Product',
      kind: 'mono',
      filter: 'text',
      accessor: (r) => r.product_variant ?? r.product_code ?? '—',
    },
    { key: 'category', label: 'Category', kind: 'text', filter: 'select', source: 'easyecom', accessor: (r) => r.category ?? '—' },
    { key: 'vendor_name', label: 'Vendor', kind: 'text', filter: 'select', source: 'easyecom', accessor: (r) => r.vendor_name ?? '—' },
    { key: 'po_ref_num', label: 'PO ref', kind: 'mono', source: 'easyecom', accessor: (r) => r.po_ref_num ?? r.po_number ?? '—' },
    {
      key: 'expected_qty',
      label: 'Expected',
      kind: 'num',
      accessor: (r) => num(r.expected_qty),
      render: (r) => (r.expected_qty == null ? '—' : fmt.format(num(r.expected_qty))),
      info: "WHAT: how many pieces the team said would arrive.\n\nHOW: the quantity typed on the Inward Plan for this PO and product, for the chosen week.\n\nUSE: the promise the Received column is measured against.",
    },
    {
      key: 'expected_week',
      label: 'Expected week / month',
      kind: 'text',
      accessor: (r) => r.expected_week ?? '',
      render: (r) => r.expected_week ?? '—',
      info: "WHAT: when the team said the goods would arrive.\n\nHOW: an ISO week when one was entered; a whole month when only the month was filled.\n\nUSE: a month-only entry is a weaker promise — it cannot be checked week by week.",
    },
    {
      key: 'received_qty',
      source: 'easyecom',
      label: 'Received',
      kind: 'num',
      accessor: (r) => num(r.received_qty),
      render: (r) => fmt.format(num(r.received_qty)),
      info: "WHAT: how many pieces actually arrived.\n\nHOW: goods-receipt (GRN) quantity for this PO and product.\n\nUSE: the reality the plan is measured against.",
    },
    {
      key: 'received_weeks',
      source: 'easyecom',
      label: 'Received week(s)',
      kind: 'text',
      accessor: (r) => r.received_weeks ?? '',
      render: (r) => r.received_weeks ?? '—',
      info: "WHAT: when the goods actually arrived.\n\nHOW: the ISO week of the goods receipt's created date; several weeks when the PO came in parts.\n\nUSE: compare with the Expected week to see how late (or early) the delivery was.",
    },
    {
      key: 'variance',
      source: 'computed',
      label: 'Variance',
      kind: 'num',
      accessor: (r) => num(r.variance),
      render: (r) =>
        r.variance == null ? '—' : `${r.variance > 0 ? '+' : ''}${fmt.format(r.variance)}`,
      info: "WHAT: how far the delivery was from the plan.\n\nHOW: received − expected. Example: expected 500, received 320 → −180.\n\nUSE: negative = short of plan (chase the balance); positive = more than planned (check it was wanted).",
    },
    {
      key: 'status',
      label: 'Status',
      kind: 'text',
      filter: 'select',
      accessor: (r) => r.status || '—',
    },
    {
      key: 'remarks',
      label: 'Remarks',
      kind: 'text',
      accessor: (r) => r.remarks ?? '',
      render: (r) => r.remarks ?? '—',
      info: "WHAT: any note the team left on the plan line.\n\nHOW: from the approved historical plan sheet; live Inward Plan rows keep their remark in the approval history instead.\n\nUSE: context for a gap — a vendor delay already known, a part-shipment agreed.",
    },
  ];

  return (
    <>
      <div className="metric-grid compact">
        <div className="metric-card tone-purple">
          <span className="metric-label">Expected (Inward Plan)</span>
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
          onVisibleRows={setVisible}
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
