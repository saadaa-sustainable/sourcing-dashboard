'use client';

import { Notice } from '@/components/forms/form-layout';
import { FilterTable, type Column } from '@/components/filter-table';
import type { EeProductMaster } from '@/lib/forms/types';

const COLS: Column<EeProductMaster>[] = [
  { key: 'sku', label: 'SKU', kind: 'mono' },
  { key: 'product_variant', label: 'Variant', kind: 'mono' },
  { key: 'product_name', label: 'Product Name', kind: 'text' },
  { key: 'colour', label: 'Colour', kind: 'text' },
  { key: 'size', label: 'Size', kind: 'text' },
  { key: 'product_state', label: 'Status', kind: 'text' },
  { key: 'weave_type', label: 'Weave', kind: 'text' },
  { key: 'category_name', label: 'Category', kind: 'text' },
  { key: 'gender', label: 'Gender', kind: 'text' },
  { key: 'item_category', label: 'Item Category', kind: 'text' },
  { key: 'sub_category', label: 'Sub-category', kind: 'text' },
  { key: 'rm_fabric_sku', label: 'RM Fabric SKU', kind: 'mono' },
  { key: 'dyed_fabric_sku', label: 'Dyed Fabric SKU', kind: 'mono' },
  { key: 'fabric_name', label: 'Fabric', kind: 'text' },
  { key: 'fabric_composition', label: 'Composition', kind: 'text' },
  { key: 'fabric_gsm', label: 'GSM', kind: 'text' },
  { key: 'fit_type', label: 'Fit', kind: 'text' },
  { key: 'sleeve_type', label: 'Sleeve', kind: 'text' },
  { key: 'neck_collar_type', label: 'Neck/Collar', kind: 'text' },
  { key: 'season', label: 'Season', kind: 'text' },
  { key: 'replenishment_type', label: 'Replen. Type', kind: 'text' },
  { key: 'product_type', label: 'Product Type', kind: 'text' },
  { key: 'product_launch_date', label: 'Launch Date', kind: 'text' },
  { key: 'mrp', label: 'MRP', kind: 'num' },
  { key: 'cost', label: 'Cost', kind: 'num' },
];

export function ProductMasterClient({ products }: { products: EeProductMaster[] }) {
  return (
    <>
      <Notice tone="info">
        SKU-level product master from EasyEcom (Easyecom_new_product_master + custom fields),
        refreshed daily. Read-only.
      </Notice>
      <FilterTable
        rows={products}
        columns={COLS}
        rowKey={(r) => r.sku}
        unit="SKUs"
        searchPlaceholder="SKU, name, variant or colour"
        emptyText="No SKUs match your filters."
      />
    </>
  );
}
