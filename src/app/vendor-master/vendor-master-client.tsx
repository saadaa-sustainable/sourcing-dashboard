'use client';

import { Notice } from '@/components/forms/form-layout';
import { FilterTable, type Column } from '@/components/filter-table';
import type { VendorMasterRow } from '@/lib/forms/types';

// Only the fields the GCP sync (BqSync `vendors()`) actually fetches into
// vendor_master_data — vendor identity + EasyEcom status. The sheet-owned
// capacity model, contacts, type/merchant etc. are deliberately NOT shown here.
const COLS: Column<VendorMasterRow>[] = [
  { key: 'vendor_code', label: 'Vendor Code', kind: 'mono' },
  { key: 'vendor_name', label: 'Vendor', kind: 'text' },
  { key: 'ee_status', label: 'EasyEcom Status', kind: 'text', accessor: (r) => r.ee_status ?? '', info: 'Raw active/inactive status synced from EasyEcom via GCP — the source of truth for the active-vendor filter.' },
];

export function VendorMasterClient({ rows }: { rows: VendorMasterRow[] }) {
  return (
    <>
      <Notice tone="info">
        Vendor identity and EasyEcom status, fetched from GCP (vendor_master_data). Read-only —
        the capacity model and contacts live on the Vendor Master sheet and are not shown here.
      </Notice>
      <FilterTable
        rows={rows}
        columns={COLS}
        rowKey={(r) => r.vendor_code}
        unit="vendors"
        searchPlaceholder="Vendor, code, merchant or type"
        emptyText="No vendors match your filters."
      />
    </>
  );
}
