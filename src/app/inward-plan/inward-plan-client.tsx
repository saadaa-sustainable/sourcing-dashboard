'use client';

import { Notice } from '@/components/forms/form-layout';
import { FilterTable, type Column } from '@/components/filter-table';
import type { InwardPlanGroup } from '@/lib/forms/types';

const fmt = new Intl.NumberFormat('en-IN', { maximumFractionDigits: 0 });

const COLS: Column<InwardPlanGroup>[] = [
  { key: 'po_number', label: 'PO', kind: 'mono' },
  { key: 'product_code', label: 'Product', kind: 'text' },
  { key: 'product_variant', label: 'Variant', kind: 'mono' },
  {
    key: 'vendor_name',
    label: 'Vendor',
    kind: 'text',
    accessor: (g) => `${g.vendor_name ?? ''} ${g.vendor_code ?? ''}`,
    render: (g) => (
      <>
        {g.vendor_name}
        <small>{g.vendor_code}</small>
      </>
    ),
  },
  { key: 'ordered_qty', label: 'Ordered', kind: 'num' },
  { key: 'arriving_qty', label: 'Arriving', kind: 'num', render: (g) => <strong>{fmt.format(g.arriving_qty)}</strong> },
  { key: 'expected_delivery_date', label: 'Expected', kind: 'text' },
];

export function InwardPlanClient({ groups }: { groups: InwardPlanGroup[] }) {
  if (!groups.length) {
    return (
      <Notice tone="info">
        No open POs with stock still to arrive. (Loads once the PO backfill has run.)
      </Notice>
    );
  }
  return (
    <FilterTable
      rows={groups}
      columns={COLS}
      rowKey={(g) => `${g.po_number}-${g.product_code}-${g.product_variant}`}
      unit="lines"
      searchPlaceholder="PO, product, variant or vendor"
      emptyText="No lines match your filters."
    />
  );
}
