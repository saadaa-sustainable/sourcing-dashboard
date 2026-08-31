'use client';

import { Notice } from '@/components/forms/form-layout';
import { FilterTable, type Column } from '@/components/filter-table';
import type { GrnDetail } from '@/lib/forms/types';

const date = (v: string | null) => (v ? String(v).slice(0, 10) : '');

const COLS: Column<GrnDetail>[] = [
  { key: 'grn_detail_id', label: 'GRN Line ID', kind: 'mono' },
  { key: 'grn_id', label: 'GRN ID', kind: 'mono' },
  { key: 'grn_created_at', label: 'GRN Date', kind: 'text', accessor: (r) => date(r.grn_created_at) },
  { key: 'grn_invoice_date', label: 'Invoice Date', kind: 'text', accessor: (r) => date(r.grn_invoice_date) },
  { key: 'sku', label: 'SKU', kind: 'mono' },
  { key: 'vendor_name', label: 'Vendor', kind: 'text' },
  { key: 'po_number', label: 'PO No.', kind: 'mono' },
  { key: 'po_ref_num', label: 'PO Ref', kind: 'mono' },
  { key: 'original_quantity', label: 'Ordered', kind: 'num', info: 'Pieces ordered on this PO line.' },
  { key: 'received_quantity', label: 'Received', kind: 'num', info: 'Pieces physically received against this line.' },
  { key: 'qc_pass', label: 'QC Pass', kind: 'num', info: 'Received pieces that passed quality check.' },
  { key: 'qc_fail', label: 'QC Fail', kind: 'num', info: 'Received pieces that failed quality check.' },
  { key: 'qc_pending', label: 'QC Pending', kind: 'num', info: 'Received pieces not yet quality-checked.' },
  { key: 'damaged', label: 'Damaged', kind: 'num', info: 'Pieces marked damaged on receipt.' },
  { key: 'discard', label: 'Discard', kind: 'num', info: 'Pieces discarded as unusable.' },
  { key: 'lost', label: 'Lost', kind: 'num', info: 'Pieces recorded as lost.' },
  { key: 'return_to_source', label: 'Return to Source', kind: 'num', info: 'Pieces returned to the vendor.' },
  { key: 'po_id', label: 'PO ID', kind: 'mono' },
  { key: 'purchase_order_detail_id', label: 'PO Line ID', kind: 'mono' },
  { key: 'product_id', label: 'Product ID', kind: 'mono' },
  { key: 'vendor_c_id', label: 'Vendor C-ID', kind: 'mono' },
  { key: 'synced_at', label: 'Synced', kind: 'text', accessor: (r) => date(r.synced_at) },
];

export function GrnDetailClient({ rows, limit }: { rows: GrnDetail[]; limit: number }) {
  const capped = rows.length >= limit;
  return (
    <>
      <Notice tone="info">
        Inbound-QC GRN lines from EasyEcom (sd_ee_grn), refreshed daily. Read-only.
        {capped
          ? ` Showing the ${limit.toLocaleString('en-IN')} most recent GRN lines (the full table has 170k+ rows) — filter or search to find older lines.`
          : ''}
      </Notice>
      <FilterTable
        rows={rows}
        columns={COLS}
        rowKey={(r) => String(r.grn_detail_id)}
        unit="GRN lines"
        searchPlaceholder="SKU, vendor, PO number or ref"
        emptyText="No GRN lines match your filters."
      />
    </>
  );
}
