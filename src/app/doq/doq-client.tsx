'use client';

import { Notice } from '@/components/forms/form-layout';
import { DataAsOf } from '@/components/forms/data-as-of';
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
  { key: 'product_state', label: 'Product State', kind: 'text' },
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
  { key: 'current_stock', label: 'Current Stock', kind: 'num', info: "WHAT: pieces of this SKU in this warehouse as of the snapshot.\n\nHOW: sellable stock from the nightly inventory feed.\n\nUSE: zero here on the Main Warehouse row is what 'out of stock yesterday' means on the OOS pages." },
  { key: 'total_inprogress', label: 'In-process', kind: 'num', info: "WHAT: pieces on order for this SKU that have not arrived.\n\nHOW: pending quantity on approved POs.\n\nUSE: stock + this is what the reorder rule counts as cover." },
  { key: 'has_inventory_today', label: 'Has Inv. Today', kind: 'num', info: "WHAT: was this SKU in stock on the snapshot day.\n\nHOW: 1 when sellable stock is above zero, else 0.\n\nUSE: the flag the OOS-days counts are built from, one day at a time." },
  { key: 'daily_quantity', label: 'Daily Qty', kind: 'num', info: "WHAT: how many pieces a day this SKU sells.\n\nHOW: pieces sold ÷ days in stock, over the source's window.\n\nUSE: the demand rate behind every DOQ column." },
  { key: 'lead_time', label: 'Lead Time', kind: 'num', info: "WHAT: how long a reorder takes to land.\n\nHOW: lead time in days as held in the source, by PO type.\n\nUSE: stock must cover at least this many days or the SKU will run out before the next order arrives." },
  { key: 'buffer_days', label: 'Buffer Days', kind: 'num', info: "WHAT: extra days of cover kept on top of the lead time.\n\nHOW: buffer days as held in the source.\n\nUSE: protects against a late vendor or a sales spike." },
  { key: 't7_quantity', label: 'T7 Qty', kind: 'num' },
  { key: 't45_quantity', label: 'T45 Qty', kind: 'num' },
  { key: 't730_quantity', label: 'T730 Qty', kind: 'num' },
  { key: 't73015_quantity', label: 'T730-15 Qty', kind: 'num' },
  { key: 'total_sales_in_last_45_inventory_days', label: 'Sales (45 inv-days)', kind: 'num' },
  { key: 'doq_7', label: 'DOQ 7', kind: 'num', info: "WHAT: DOQ — the daily sales rate measured over a 7-day window.\n\nHOW: pieces sold in the last 7 days ÷ days in stock in those 7 days. The DOQ 15 / 30 / 45 / 90 / 365 columns are the same measure over longer windows; the range columns (7–30, 30–45) cover just that slice.\n\nUSE: short windows react fast but swing; the 45-day figure is what ordering uses (IPDOQ on Replenishment)." },
  { key: 'doq_15', label: 'DOQ 15', kind: 'num' },
  { key: 'doq_30', label: 'DOQ 30', kind: 'num' },
  { key: 'doq_45', label: 'DOQ 45', kind: 'num' },
  { key: 'doq_90', label: 'DOQ 90', kind: 'num' },
  { key: 'doq_365', label: 'DOQ 365', kind: 'num' },
  { key: 'doq_7_30', label: 'DOQ 7-30', kind: 'num' },
  { key: 'doq_30_45', label: 'DOQ 30-45', kind: 'num' },
  { key: 'monthly_doq', label: 'Monthly DOQ', kind: 'num' },
  { key: 'yearly_doq', label: 'Yearly DOQ', kind: 'num' },
  { key: 'v_doq', label: 'V-DOQ', kind: 'num', info: "WHAT: a DOQ scaled up or down by how fast the SKU is currently moving.\n\nHOW: the source's velocity adjustment on the base DOQ.\n\nUSE: an experimental figure from the feed; ordering uses IPDOQ, not this." },
  { key: 'weighted_doq_45', label: 'Weighted DOQ 45', kind: 'num', info: "WHAT: the 45-day DOQ with recent days counting for more.\n\nHOW: the source's weighting on DOQ 45.\n\nUSE: reacts sooner to a change in demand than the plain 45-day figure." },
  { key: 'weightage_doq', label: 'Weightage DOQ', kind: 'num' },
  { key: 'oos_days_7', label: 'OOS Days 7', kind: 'num', info: "WHAT: how many of the last 7 days this SKU had no stock in this warehouse.\n\nHOW: days with stock at zero, counted per warehouse row. The OOS Days 15 / 30 / 45 / 90 / 365 columns are the same over longer windows.\n\nMIND: per warehouse. A STORE row can show 45 of 45 for a SKU the store simply never carries; the Main Warehouse row is the one the OOS pages read." },
  { key: 'oos_days_15', label: 'OOS Days 15', kind: 'num' },
  { key: 'oos_days_30', label: 'OOS Days 30', kind: 'num' },
  { key: 'oos_days_45', label: 'OOS Days 45', kind: 'num' },
  { key: 'oos_days_90', label: 'OOS Days 90', kind: 'num' },
  { key: 'oos_days_365', label: 'OOS Days 365', kind: 'num' },
  { key: 'synced_at', label: 'Synced', kind: 'text', accessor: (r) => date(r.synced_at) },
];

export function DoqClient({
  rows,
  dataAsOf = null,
  lastSynced = null,
}: {
  rows: DoqInventoryRow[];
  dataAsOf?: string | null;
  lastSynced?: string | null;
}) {
  return (
    <>
      <Notice tone="info">
        The full daily DOQ snapshot (sd_inventory_planning), refreshed daily from BigQuery.
        Read-only — one row per SKU × warehouse.
      </Notice>
      <DataAsOf dataAsOf={dataAsOf} lastSynced={lastSynced} />
      <FilterTable
        rows={rows}
        columns={COLS}
        rowKey={(r) => r.row_key}
        defaultSource="bigquery"
        unit="rows"
        searchPlaceholder="SKU, variant, product or category"
        emptyText="No rows match your filters."
        download={{ filename: 'doq-dataset' }}
      />
    </>
  );
}
