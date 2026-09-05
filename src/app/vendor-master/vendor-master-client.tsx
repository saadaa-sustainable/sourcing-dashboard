'use client';

import { Notice } from '@/components/forms/form-layout';
import { FilterTable, type Column } from '@/components/filter-table';
import type { EeVendorMasterRow } from '@/lib/forms/types';

const date = (v: string | null) => (v ? String(v).slice(0, 10) : '');

// EasyEcom lands the address as a JSON blob { dispatch, billing }; render the
// dispatch (else billing) address as a readable line, keeping the raw value for
// search. Empty objects/arrays render as "—".
function formatAddress(raw: string | null): string {
  if (!raw) return '';
  try {
    const o = JSON.parse(raw) as {
      dispatch?: unknown;
      billing?: unknown;
    };
    const pick = (v: unknown) =>
      v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
    const a = pick(o.dispatch) ?? pick(o.billing);
    if (!a) return '';
    return [a.address, a.city, a.state_name, a.zip, a.country]
      .map((x) => (x == null ? '' : String(x).trim()))
      .filter(Boolean)
      .join(', ');
  } catch {
    return raw;
  }
}

// Every field of the raw EasyEcom vendor master (sd_ee_vendor_master), in source
// order. No Google-Sheet columns — this is the EasyEcom table as-is.
const COLS: Column<EeVendorMasterRow>[] = [
  { key: 'vendor_code', label: 'Vendor Code', kind: 'mono' },
  { key: 'vendor_name', label: 'Vendor', kind: 'text' },
  {
    key: 'active',
    label: 'Active',
    info: 'EasyEcom active flag (1 = active, 0 = inactive), as held in Easyecom_Saadaa_vendors.',
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
  { key: 'vendor_c_id', label: 'EasyEcom ID', kind: 'mono', info: "EasyEcom's internal vendor id (vendor_c_id)." },
  {
    key: 'contact_person',
    label: 'Contact Person',
    kind: 'text',
    accessor: (r) => [r.firstname, r.lastname].map((x) => (x ?? '').trim()).filter(Boolean).join(' '),
    info: 'EasyEcom firstname + lastname.',
  },
  { key: 'contact_number', label: 'Contact No.', kind: 'text', accessor: (r) => r.contact_number ?? '' },
  { key: 'email', label: 'Email', kind: 'text' },
  { key: 'pan', label: 'PAN', kind: 'mono', accessor: (r) => r.pan ?? '' },
  { key: 'tax_identification_number', label: 'GSTIN', kind: 'mono', accessor: (r) => r.tax_identification_number ?? '', info: 'Tax identification number (GSTIN).' },
  { key: 'msme_number', label: 'MSME / Udyam', kind: 'text', accessor: (r) => r.msme_number ?? '' },
  { key: 'paymentterm', label: 'Payment Term', kind: 'text', filter: 'select' },
  { key: 'deliveryterm', label: 'Delivery Term', kind: 'text', filter: 'select' },
  { key: 'currency_code', label: 'Currency', kind: 'text', filter: 'select' },
  {
    key: 'unregistered_vendor',
    label: 'Unregistered',
    kind: 'text',
    filter: 'select',
    accessor: (r) => {
      const v = (r.unregistered_vendor ?? '').toLowerCase();
      if (v === '' ) return '';
      return v === '1' || v === 'true' ? 'Yes' : 'No';
    },
    info: "EasyEcom's unregistered-vendor flag (no GST registration).",
  },
  {
    key: 'address',
    label: 'Address',
    kind: 'text',
    accessor: (r) => formatAddress(r.address),
    render: (r) => {
      const a = formatAddress(r.address);
      return a ? <span>{a}</span> : <span className="wf-subtle">—</span>;
    },
  },
  { key: 'dl_number', label: 'DL No.', kind: 'text', accessor: (r) => r.dl_number ?? '', info: 'Drug licence number (where applicable).' },
  { key: 'dl_expiry', label: 'DL Expiry', kind: 'text', accessor: (r) => r.dl_expiry ?? '' },
  { key: 'fssai_number', label: 'FSSAI No.', kind: 'text', accessor: (r) => r.fssai_number ?? '' },
  { key: 'fssai_expiry', label: 'FSSAI Expiry', kind: 'text', accessor: (r) => r.fssai_expiry ?? '' },
  { key: 'freight_forwarding_days', label: 'Freight Fwd Days', kind: 'text', accessor: (r) => r.freight_forwarding_days ?? '' },
  { key: 'prep_days', label: 'Prep Days', kind: 'text', accessor: (r) => r.prep_days ?? '' },
  { key: 'shipment_intransit_days', label: 'In-Transit Days', kind: 'text', accessor: (r) => r.shipment_intransit_days ?? '' },
  { key: 'warehouse_checkin_time', label: 'WH Check-in', kind: 'text', accessor: (r) => r.warehouse_checkin_time ?? '' },
  { key: 'vendor_token', label: 'Vendor Token', kind: 'mono', accessor: (r) => r.vendor_token ?? '' },
  { key: 'api_token', label: 'API Token', kind: 'mono', accessor: (r) => r.api_token ?? '' },
  { key: 'synced_at', label: 'Synced', kind: 'text', accessor: (r) => date(r.synced_at), info: 'When this row was last pulled from GCP.' },
];

export function VendorMasterClient({ rows }: { rows: EeVendorMasterRow[] }) {
  return (
    <>
      <Notice tone="info">
        The EasyEcom vendor master exactly as GCP holds it (Easyecom_Saadaa_vendors →
        sd_ee_vendor_master) — every field, no Google-Sheet data. Read-only.
      </Notice>
      <FilterTable
        rows={rows}
        columns={COLS}
        rowKey={(r) => r.vendor_code ?? r.vendor_c_id ?? r.vendor_name ?? ''}
        unit="vendors"
        searchPlaceholder="Vendor, code, email or term"
        emptyText="No vendors match your filters."
      />
    </>
  );
}
