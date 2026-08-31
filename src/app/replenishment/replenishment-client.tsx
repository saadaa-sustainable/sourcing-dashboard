'use client';

import { FilterTable, type Column } from '@/components/filter-table';
import type { ReplenishmentRow } from '@/lib/forms/types';

const fmt = new Intl.NumberFormat('en-IN', { maximumFractionDigits: 0 });

const COLS: Column<ReplenishmentRow>[] = [
  {
    key: 'product_variant',
    label: 'Product / colour',
    kind: 'mono',
    accessor: (r) => `${r.product_variant} ${r.product_name ?? ''} ${r.product_code ?? ''}`,
    render: (r) => (
      <>
        <span className="mono">{r.product_variant}</span>
        <small className="wf-subtle">{r.product_name ?? r.product_code}</small>
      </>
    ),
  },
  { key: 'product_state', label: 'Product State', kind: 'text', accessor: (r) => r.product_state, info: 'Lifecycle state of the product, rolled up from the product master.' },
  { key: 'current_stock', label: 'Stock', kind: 'num', info: 'Sellable stock on hand right now.' },
  { key: 'in_progress', label: 'In process', kind: 'num', info: 'Quantity already on order or in production, not yet received.' },
  { key: 'daily_demand', label: 'Daily demand', kind: 'num', info: 'Average daily sales rate used to size replenishment.' },
  { key: 'doq_45', label: 'DOQ', kind: 'num', info: 'Days of Quantity — how many days current stock covers at the daily demand rate.' },
  {
    key: 'oos_flag',
    label: 'OOS',
    kind: 'text',
    info: 'Flagged out of stock — zero sellable stock on hand.',
    accessor: (r) => (r.oos_flag ? 'OOS' : ''),
    render: (r) => (r.oos_flag ? <span className="wf-over-tag">OOS</span> : <span className="wf-subtle">—</span>),
  },
  { key: 'rop_30', label: '30d', kind: 'num', info: 'Suggested reorder quantity to cover the next 30 days of demand.', render: (r) => <strong>{fmt.format(r.rop_30)}</strong> },
  { key: 'rop_60', label: '60d', kind: 'num', info: 'Suggested reorder quantity to cover the next 60 days of demand.' },
  { key: 'rop_90', label: '90d', kind: 'num', info: 'Suggested reorder quantity to cover the next 90 days of demand.' },
];

export function ReplenishmentClient({ rows }: { rows: ReplenishmentRow[] }) {
  return (
    <FilterTable
      rows={rows}
      columns={COLS}
      rowKey={(r) => r.product_variant}
      rowClass={(r) => (r.oos_flag ? 'wf-row-over' : undefined)}
      unit="colours"
      searchPlaceholder="Product, colour or code"
      emptyText="Nothing needs reordering right now."
    />
  );
}
