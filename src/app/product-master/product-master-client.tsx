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
  { key: 'product_state', label: 'Product State', kind: 'text', info: 'Lifecycle state from the master — Ongoing, NPD, To Be Discontinued, Discontinued, etc.' },
  { key: 'weave_type', label: 'Weave', kind: 'text' },
  { key: 'category_name', label: 'Category', kind: 'text' },
  { key: 'gender', label: 'Gender', kind: 'text' },
  { key: 'item_category', label: 'Item Category', kind: 'text' },
  { key: 'sub_category', label: 'Sub-category', kind: 'text' },
  { key: 'rm_fabric_sku', label: 'RM Fabric SKU', kind: 'mono', info: 'Raw (greige) fabric SKU used for this product.' },
  { key: 'dyed_fabric_sku', label: 'Dyed Fabric SKU', kind: 'mono', info: 'Dyed / finished fabric SKU used for this product.' },
  { key: 'fabric_name', label: 'Fabric', kind: 'text' },
  { key: 'fabric_composition', label: 'Composition', kind: 'text' },
  { key: 'fabric_gsm', label: 'GSM', kind: 'text' },
  { key: 'fit_type', label: 'Fit', kind: 'text' },
  { key: 'sleeve_type', label: 'Sleeve', kind: 'text' },
  { key: 'neck_collar_type', label: 'Neck/Collar', kind: 'text' },
  { key: 'season', label: 'Season', kind: 'text' },
  { key: 'replenishment_type', label: 'Replen. Type', kind: 'text', info: 'How the product is replenished — e.g. continuous vs one-time / seasonal.' },
  { key: 'product_type', label: 'Product Type', kind: 'text' },
  { key: 'product_launch_date', label: 'Launch Date', kind: 'text' },
  { key: 'mrp', label: 'MRP', kind: 'num' },
  { key: 'cost', label: 'Cost', kind: 'num' },
  { key: 'category_type', label: 'Category Type', kind: 'text' },
  { key: 'color_family', label: 'Colour Family', kind: 'text' },
  { key: 'garment_length_type', label: 'Garment Length', kind: 'text' },
  { key: 'demographic_price_rage', label: 'Price Range', kind: 'text' },
  { key: 'fabric_consumption_average', label: 'Fabric Cons. Avg', kind: 'num', info: 'Average fabric consumed per piece.' },
  // NOTE: the EasyEcom QTY_IN_METERS custom field actually holds gender + wear
  // type values (F TOP WEAR …), so it renders as text, not a number.
  { key: 'qty_in_meters', label: 'Qty in Meters', kind: 'text', info: 'Despite the name, this EasyEcom field stores gender + wear-type (e.g. "F TOP WEAR"), not a meter quantity.' },
  { key: 'related_ongoing_product', label: 'Related Ongoing', kind: 'mono', info: 'The ongoing product this NPD / variant maps to.' },
  { key: 'washcare_sku', label: 'Washcare SKU', kind: 'mono' },
  {
    key: 'active',
    label: 'Active',
    // Stored as "1"/"0" in EasyEcom — surface it as Active/Inactive so it reads
    // as a status, and drive the filter dropdown off the same labels.
    accessor: (r) => (r.active == null || r.active === '' ? '' : r.active === '1' ? 'Active' : 'Inactive'),
    render: (r) => {
      if (r.active == null || r.active === '') return <span className="wf-subtle">—</span>;
      const on = r.active === '1';
      return (
        <span
          style={{
            background: on ? '#ecf1e9' : '#fdecea',
            color: on ? '#4f7c4d' : '#c0392b',
            padding: '2px 8px',
            borderRadius: 10,
            fontSize: 12,
            fontWeight: 600,
          }}
        >
          {on ? 'Active' : 'Inactive'}
        </span>
      );
    },
  },
  { key: 'width', label: 'Width', kind: 'num' },
  { key: 'height', label: 'Height', kind: 'num' },
  { key: 'length', label: 'Length', kind: 'num' },
  { key: 'weight', label: 'Weight', kind: 'num' },
  { key: 'hsn_code', label: 'HSN', kind: 'mono' },
  { key: 'model_no', label: 'Model No', kind: 'mono' },
  { key: 'gst', label: 'GST', kind: 'text' },
  { key: 'tax_rate', label: 'Tax Rate', kind: 'text' },
  { key: 'tax_rule_name', label: 'Tax Rule', kind: 'text' },
  {
    key: 'product_image_url',
    label: 'Image',
    filter: 'none',
    sortable: false,
    render: (r) =>
      r.product_image_url ? (
        <a href={r.product_image_url} target="_blank" rel="noopener noreferrer">
          open
        </a>
      ) : (
        <span className="wf-subtle">—</span>
      ),
  },
  { key: 'description', label: 'Description', kind: 'text' },
  {
    key: 'created_at',
    label: 'Created',
    kind: 'text',
    accessor: (r) => (r.created_at ? String(r.created_at).slice(0, 10) : ''),
  },
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
