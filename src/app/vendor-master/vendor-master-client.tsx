'use client';

import { Notice } from '@/components/forms/form-layout';
import { FilterTable, type Column } from '@/components/filter-table';
import type { VendorMasterRow } from '@/lib/forms/types';

const date = (v: string | null) => (v ? String(v).slice(0, 10) : '');

const COLS: Column<VendorMasterRow>[] = [
  { key: 'vendor_code', label: 'Vendor Code', kind: 'mono' },
  { key: 'vendor_name', label: 'Vendor', kind: 'text' },
  {
    key: 'is_active',
    label: 'Active',
    accessor: (r) => (r.is_active == null ? '' : r.is_active ? 'Active' : 'Inactive'),
    render: (r) => {
      if (r.is_active == null) return <span className="wf-subtle">—</span>;
      return (
        <span
          style={{
            background: r.is_active ? '#e6f4ea' : '#fce8e6',
            color: r.is_active ? '#137333' : '#c5221f',
            padding: '2px 8px',
            borderRadius: 10,
            fontSize: 12,
            fontWeight: 600,
          }}
        >
          {r.is_active ? 'Active' : 'Inactive'}
        </span>
      );
    },
  },
  { key: 'primary_type', label: 'Type', kind: 'text' },
  { key: 'merchant_name', label: 'Merchant', kind: 'text' },
  { key: 'capacity_per_month', label: 'Capacity / Month', kind: 'num' },
  { key: 'total_machines', label: 'Total Machines', kind: 'num' },
  { key: 'machines_for_saadaa', label: 'Machines for SAADAA', kind: 'num' },
  { key: 'total_active_karigar', label: 'Active Karigars', kind: 'num' },
  { key: 'karigar_latest', label: 'Karigars (Latest)', kind: 'num' },
  { key: 'karigar_latest_as_of', label: 'Karigars As-of', kind: 'text', accessor: (r) => date(r.karigar_latest_as_of) },
  { key: 'onboarding_date', label: 'Onboarded', kind: 'text', accessor: (r) => date(r.onboarding_date) },
  { key: 'fob_complete_possible', label: 'FOB Possible', kind: 'text' },
  { key: 'vendor_preference', label: 'Preference', kind: 'text' },
  { key: 'contact_person_name', label: 'Contact Person', kind: 'text' },
  { key: 'contact_no', label: 'Contact No.', kind: 'text' },
  { key: 'address', label: 'Address', kind: 'text' },
  { key: 'synced_at', label: 'Synced', kind: 'text', accessor: (r) => date(r.synced_at) },
];

export function VendorMasterClient({ rows }: { rows: VendorMasterRow[] }) {
  return (
    <>
      <Notice tone="info">
        Vendor master records (vendor_master_data). Vendor names refresh daily from GCP; the
        capacity model and contacts come from the Vendor Master sheet. Read-only.
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
