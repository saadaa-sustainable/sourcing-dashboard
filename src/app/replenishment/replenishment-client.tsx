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
  { key: 'product_state', label: 'Status', kind: 'text', accessor: (r) => r.product_state },
  { key: 'current_stock', label: 'Stock', kind: 'num' },
  { key: 'in_progress', label: 'In process', kind: 'num' },
  { key: 'daily_demand', label: 'Daily demand', kind: 'num' },
  { key: 'doq_45', label: 'DOQ', kind: 'num' },
  {
    key: 'oos_flag',
    label: 'OOS',
    kind: 'text',
    accessor: (r) => (r.oos_flag ? 'OOS' : ''),
    render: (r) => (r.oos_flag ? <span className="wf-over-tag">OOS</span> : <span className="wf-subtle">—</span>),
  },
  { key: 'rop_30', label: '30d', kind: 'num', render: (r) => <strong>{fmt.format(r.rop_30)}</strong> },
  { key: 'rop_60', label: '60d', kind: 'num' },
  { key: 'rop_90', label: '90d', kind: 'num' },
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
