'use client';

import { useMemo } from 'react';
import { CheckCircle2 } from 'lucide-react';
import { FilterTable, type Column } from '@/components/filter-table';
import { InfoDot } from '@/components/info-dot';
import { unpackRows, type PackedRows } from '@/lib/packed-rows';

/** One SKU the dashboard's tables count (on the OOS feed, not on the exclusion list). */
export type IncludedSku = {
  sku: string;
  product_code: string | null;
  product_name: string | null;
  color: string | null;
  size: string | null;
  weave: string;
  product_status: string;
  product_class: string;
  com_status: string;
  current_stock: number | null;
  inprocess_stock: number | null;
  doq_45: number | null;
  oos_days_45: number | null;
};

const HELP =
  "WHAT: every SKU the tables on this page count.\n\nHOW: the SKUs on the OOS feed (Main Warehouse) minus the Excluded SKUs list above — the same set the category totals add up to. Product State comes from the EasyEcom product master first, the feed's own state as fallback; Class is the IPDOQ class used for the COM Status table.\n\nUSE: check a SKU is being counted, or download the list to reconcile a total with the DOQ sheet.";

const cols: Column<IncludedSku>[] = [
  { key: 'sku', label: 'SKU', kind: 'text', source: 'bigquery', accessor: (r) => r.sku, render: (r) => <span className="mono">{r.sku}</span> },
  { key: 'product_code', label: 'Product', kind: 'text', source: 'bigquery', accessor: (r) => r.product_code ?? '' },
  { key: 'product_name', label: 'Name', kind: 'text', source: 'bigquery', accessor: (r) => r.product_name ?? '' },
  { key: 'color', label: 'Colour', kind: 'text', source: 'bigquery', accessor: (r) => r.color ?? '' },
  { key: 'size', label: 'Size', kind: 'text', source: 'bigquery', accessor: (r) => r.size ?? '' },
  { key: 'weave', label: 'Weave', kind: 'text', filter: 'select', source: 'bigquery', accessor: (r) => r.weave },
  { key: 'product_status', label: 'Product State', kind: 'text', filter: 'select', source: 'easyecom', accessor: (r) => r.product_status },
  { key: 'product_class', label: 'Class', kind: 'text', filter: 'select', source: 'computed', accessor: (r) => r.product_class },
  { key: 'com_status', label: 'COM Status', kind: 'text', filter: 'select', source: 'computed', accessor: (r) => r.com_status },
  { key: 'current_stock', label: 'Current stock', kind: 'num', source: 'bigquery', accessor: (r) => r.current_stock ?? 0 },
  { key: 'inprocess_stock', label: 'In process', kind: 'num', source: 'easyecom', accessor: (r) => r.inprocess_stock ?? 0 },
  { key: 'doq_45', label: 'DOQ (45d)', kind: 'num', source: 'bigquery', accessor: (r) => r.doq_45 ?? 0 },
  { key: 'oos_days_45', label: 'OOS days (45d)', kind: 'num', source: 'bigquery', accessor: (r) => r.oos_days_45 ?? 0 },
];

/**
 * The counterpart of the Excluded SKUs panel: the SKUs that ARE in the calculation, folded
 * away under its heading. Read-only — a SKU leaves this list by being excluded above.
 */
export function IncludedSkuPanel({ packed }: { packed: PackedRows<IncludedSku> }) {
  const rows = useMemo(() => unpackRows(packed), [packed]);
  return (
    <details className="panel oos-excl-panel oos-incl-panel">
      <summary>
        <CheckCircle2 size={15} /> Included SKUs ({rows.length.toLocaleString('en-IN')})
        <InfoDot text={HELP} />
      </summary>
      <div style={{ marginTop: 12 }}>
        <FilterTable
          rows={rows}
          columns={cols}
          rowKey={(r) => r.sku}
          defaultSource="bigquery"
          unit="SKUs"
          pageSize={50}
          searchPlaceholder="SKU, product, name, colour or state"
          emptyText="No SKUs are being counted — check the OOS feed has synced."
          download={{ filename: 'oos-included-skus' }}
        />
      </div>
    </details>
  );
}
