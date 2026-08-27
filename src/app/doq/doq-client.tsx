'use client';

import { Notice } from '@/components/forms/form-layout';
import { FilterTable, type Column } from '@/components/filter-table';
import type { DoqInventoryRow } from '@/lib/forms/types';

const date = (v: string | null) => (v ? String(v).slice(0, 10) : '');

// Full sd_inventory_planning row. Grouped: identity → descriptive attributes →
// stock/sales → the doq_* windows → the oos_days_* windows.
const COLS: Column<DoqInventoryRow>[] = [
  { key: 'sku', label: 'SKU', kind: 'mono' },
  { key: 'product_variant', label: 'Variant', kind: 'mono' },
  { key: 'warehouse', label: 'Warehouse', kind: 'text' },
  { key: 'size', label: 'Size', kind: 'text' },
  { key: 'date_day', label: 'Snapshot', kind: 'text', accessor: (r) => date(r.date_day) },
  { key: 'product_state', label: 'Status', kind: 'text' },
  { key: 'product_name', label: 'Product Name', kind: 'text' },
  { key: 'category', label: 'Category', kind: 'text' },
  { key: 'categorytype', label: 'Category Type', kind: 'text' },
  { key: 'sub_category', label: 'Sub-category', kind: 'text' },
  { key: 'item_category', label: 'Item Category', kind: 'text' },
  { key: 'color', label: 'Colour', kind: 'text' },
  { key: 'gender', label: 'Gender', kind: 'text' },
  { key: 'age_group', label: 'Age Group', kind: 'text' },
  { key: 'season', label: 'Season', kind: 'text' },
  { key: 'weave_type', label: 'Weave', kind: 'text' },
  { key: 'fabric_name', label: 'Fabric', kind: 'text' },
  { key: 'fabric_composition', label: 'Composition', kind: 'text' },
  { key: 'fabric_gsm', label: 'GSM', kind: 'num' },
  { key: 'fabric_consumption_average', label: 'Fabric Cons. Avg', kind: 'num' },
  { key: 'garment_length_type', label: 'Garment Length', kind: 'text' },
  { key: 'neck_collar_type', label: 'Neck/Collar', kind: 'text' },
  { key: 'sleeve_type', label: 'Sleeve', kind: 'text' },
  { key: 'replenishment_type', label: 'Replen. Type', kind: 'text' },
  { key: 'demographic_price_range', label: 'Price Range', kind: 'text' },
  { key: 'related_ongoing_product', label: 'Related Ongoing', kind: 'mono' },
  { key: 'washcare_sku', label: 'Washcare SKU', kind: 'mono' },
  { key: 'rm_code', label: 'RM Code', kind: 'mono' },
  { key: 'dyed_fabric_sku', label: 'Dyed Fabric SKU', kind: 'mono' },
  { key: 'qty_in_metres', label: 'Qty in Metres', kind: 'text' },
  { key: 'gst', label: 'GST', kind: 'num' },
  { key: 'cost', label: 'Cost', kind: 'num' },
  { key: 'shopify_sp', label: 'Shopify SP', kind: 'num' },
  { key: 'current_stock', label: 'Current Stock', kind: 'num' },
  { key: 'total_inprogress', label: 'In-process', kind: 'num' },
  { key: 'has_inventory_today', label: 'Has Inv. Today', kind: 'num' },
  { key: 'daily_quantity', label: 'Daily Qty', kind: 'num' },
  { key: 'lead_time', label: 'Lead Time', kind: 'num' },
  { key: 'buffer_days', label: 'Buffer Days', kind: 'num' },
  { key: 't7_quantity', label: 'T7 Qty', kind: 'num' },
  { key: 't45_quantity', label: 'T45 Qty', kind: 'num' },
  { key: 't730_quantity', label: 'T730 Qty', kind: 'num' },
  { key: 't73015_quantity', label: 'T730-15 Qty', kind: 'num' },
  { key: 'total_sales_in_last_45_inventory_days', label: 'Sales (45 inv-days)', kind: 'num' },
  { key: 'doq_7', label: 'DOQ 7', kind: 'num' },
  { key: 'doq_15', label: 'DOQ 15', kind: 'num' },
  { key: 'doq_30', label: 'DOQ 30', kind: 'num' },
  { key: 'doq_45', label: 'DOQ 45', kind: 'num' },
  { key: 'doq_90', label: 'DOQ 90', kind: 'num' },
  { key: 'doq_365', label: 'DOQ 365', kind: 'num' },
  { key: 'doq_7_30', label: 'DOQ 7-30', kind: 'num' },
  { key: 'doq_30_45', label: 'DOQ 30-45', kind: 'num' },
  { key: 'monthly_doq', label: 'Monthly DOQ', kind: 'num' },
  { key: 'yearly_doq', label: 'Yearly DOQ', kind: 'num' },
  { key: 'v_doq', label: 'V-DOQ', kind: 'num' },
  { key: 'weighted_doq_45', label: 'Weighted DOQ 45', kind: 'num' },
  { key: 'weightage_doq', label: 'Weightage DOQ', kind: 'num' },
  { key: 'oos_days_7', label: 'OOS Days 7', kind: 'num' },
  { key: 'oos_days_15', label: 'OOS Days 15', kind: 'num' },
  { key: 'oos_days_30', label: 'OOS Days 30', kind: 'num' },
  { key: 'oos_days_45', label: 'OOS Days 45', kind: 'num' },
  { key: 'oos_days_90', label: 'OOS Days 90', kind: 'num' },
  { key: 'oos_days_365', label: 'OOS Days 365', kind: 'num' },
  { key: 'synced_at', label: 'Synced', kind: 'text', accessor: (r) => date(r.synced_at) },
];

export function DoqClient({ rows }: { rows: DoqInventoryRow[] }) {
  return (
    <>
      <Notice tone="info">
        The full daily DOQ snapshot (sd_inventory_planning), refreshed daily from BigQuery.
        Read-only — one row per SKU × warehouse.
      </Notice>
      <FilterTable
        rows={rows}
        columns={COLS}
        rowKey={(r) => r.row_key}
        unit="rows"
        searchPlaceholder="SKU, variant, product or category"
        emptyText="No rows match your filters."
      />
    </>
  );
}
