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
  { key: 'original_quantity', label: 'Ordered', kind: 'num', info: "WHAT: pieces ordered on this line.\n\nHOW: the PO quantity for this product and colour.\n\nUSE: what Received is measured against." },
  { key: 'received_quantity', label: 'Received', kind: 'num', info: "WHAT: pieces that physically arrived.\n\nHOW: the goods-receipt quantity.\n\nUSE: received below ordered = a short shipment; the balance is still pending on the PO." },
  { key: 'qc_pass', label: 'QC Pass', kind: 'num', info: "WHAT: pieces that passed inbound QC.\n\nHOW: from the GRN's QC result.\n\nUSE: the only pieces that reach sellable stock." },
  { key: 'qc_fail', label: 'QC Fail', kind: 'num', info: "WHAT: pieces that failed inbound QC.\n\nHOW: from the GRN's QC result.\n\nUSE: feeds the vendor's rejection rate on Vendor Recommendation and the De-Boarding form." },
  { key: 'qc_pending', label: 'QC Pending', kind: 'num', info: "WHAT: pieces received but not yet checked.\n\nHOW: received − passed − failed.\n\nUSE: not sellable yet; a large number here is a QC backlog, not a vendor problem." },
  { key: 'damaged', label: 'Damaged', kind: 'num', info: "WHAT: pieces that arrived damaged.\n\nHOW: the damaged disposition on the GRN.\n\nUSE: usually transit or packing — different from a QC fail." },
  { key: 'discard', label: 'Discard', kind: 'num', info: "WHAT: pieces written off on receipt.\n\nHOW: the discard disposition on the GRN.\n\nUSE: a total loss on that piece." },
  { key: 'lost', label: 'Lost', kind: 'num', info: "WHAT: pieces that never turned up.\n\nHOW: the lost disposition on the GRN.\n\nUSE: a transit claim, not a vendor quality issue." },
  { key: 'return_to_source', label: 'Return to Source', kind: 'num', info: "WHAT: pieces sent back to the vendor.\n\nHOW: the return disposition on the GRN.\n\nUSE: counts in the vendor's rejection rate." },
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
        defaultSource="easyecom"
        unit="GRN lines"
        searchPlaceholder="SKU, vendor, PO number or ref"
        emptyText="No GRN lines match your filters."
      />
    </>
  );
}
