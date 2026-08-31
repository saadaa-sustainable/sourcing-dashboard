'use client';

import { FilterTable, type Column } from '@/components/filter-table';
import type { OosCalculationRow } from '@/lib/forms/types';

// The full sheet, column-for-column. Per-column filters + click-to-sort come from FilterTable.
const COLS: Column<OosCalculationRow>[] = [
  { key: 'sku', label: 'SKU', kind: 'mono' },
  { key: 'product_status', label: 'Product State', kind: 'text' },
  { key: 'category_with_gender', label: 'Category w/ Gender', kind: 'text' },
  { key: 'rm_code', label: 'RM Code', kind: 'mono' },
  { key: 'dyed_fabric_sku', label: 'Dyed Fabric SKU', kind: 'mono' },
  { key: 'product_variant', label: 'Product Variant', kind: 'mono' },
  { key: 'product_code', label: 'Product Code', kind: 'mono' },
  { key: 'product_name', label: 'Product Name', kind: 'text' },
  { key: 'color', label: 'Colour', kind: 'text' },
  { key: 'size', label: 'Size', kind: 'text' },
  { key: 'total_inventory_days', label: 'Total Inventory Days', kind: 'num' },
  { key: 'total_oos_days', label: 'Total OOS Days', kind: 'num' },
  { key: 'total_available_days', label: 'Total Available Days', kind: 'num' },
  { key: 'total_qty_sold', label: 'Total Qty Sold', kind: 'num' },
  { key: 'doq_45', label: '45 Days DOQ', kind: 'num' },
  { key: 'launch_date', label: 'Launch Date', kind: 'text' },
  { key: 'product_class', label: 'Product Class', kind: 'text' },
  { key: 'current_stock', label: 'Current Stock', kind: 'num' },
  { key: 'doh', label: 'DOH', kind: 'num' },
  { key: 'sales_value', label: 'Sales Value', kind: 'num' },
  { key: 'sales_leakage', label: 'Sales Leakage', kind: 'num' },
  { key: 'inprocess_stock', label: 'Inprocess Stock', kind: 'num' },
  { key: 'doh_with_inprocess', label: 'DOH (+ Inprocess)', kind: 'num' },
  { key: 'cancelled', label: 'Cancelled', kind: 'num' },
  { key: 'returned', label: 'Returned', kind: 'num' },
  { key: 'com_status', label: 'COM Status', kind: 'text' },
  { key: 'weave_type', label: 'Weave Type', kind: 'text' },
];

export function OosCalculationClient({ rows }: { rows: OosCalculationRow[] }) {
  return (
    <FilterTable
      rows={rows}
      columns={COLS}
      rowKey={(r) => r.sku}
      unit="SKUs"
      searchPlaceholder="SKU, name, variant, RM or colour"
      emptyText="No SKUs match your filters."
    />
  );
}
