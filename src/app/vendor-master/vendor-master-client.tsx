'use client';

import { useMemo } from 'react';

import { Notice } from '@/components/forms/form-layout';
import { DeboardedPill } from '@/components/forms/deboarded-pill';
import { FilterTable, type Column } from '@/components/filter-table';
import type { DeboardedVendor, EeVendorMasterRow } from '@/lib/forms/types';

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
    info: "WHAT: whether EasyEcom treats this vendor as active.\n\nHOW: EasyEcom's own flag (1 = active, 0 = inactive), copied as-is.\n\nUSE: this is what decides whether the vendor appears in Vendor Capacity and the PO pickers. It is separate from the dashboard's De-boarding column.",
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
  { key: 'vendor_c_id', label: 'EasyEcom ID', kind: 'mono', info: "WHAT: EasyEcom's internal id for the vendor.\n\nHOW: vendor_c_id, copied as-is.\n\nUSE: for matching against EasyEcom exports; the Vendor Code is what people use." },
  {
    key: 'contact_person',
    label: 'Contact Person',
    kind: 'text',
    accessor: (r) => [r.firstname, r.lastname].map((x) => (x ?? '').trim()).filter(Boolean).join(' '),
    info: "WHAT: the contact person at the vendor.\n\nHOW: EasyEcom's first name + last name.\n\nUSE: who to call.",
  },
  { key: 'contact_number', label: 'Contact No.', kind: 'text', accessor: (r) => r.contact_number ?? '' },
  { key: 'email', label: 'Email', kind: 'text' },
  { key: 'pan', label: 'PAN', kind: 'mono', accessor: (r) => r.pan ?? '' },
  { key: 'tax_identification_number', label: 'GSTIN', kind: 'mono', accessor: (r) => r.tax_identification_number ?? '', info: "WHAT: the vendor's GST number.\n\nHOW: from EasyEcom.\n\nUSE: needed on every invoice; blank plus 'unregistered' = no GST registration." },
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
    info: "WHAT: whether the vendor is registered for GST.\n\nHOW: EasyEcom's unregistered flag.\n\nUSE: unregistered vendors change how tax is handled on the PO.",
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
  { key: 'dl_number', label: 'DL No.', kind: 'text', accessor: (r) => r.dl_number ?? '', info: "WHAT: a drug licence number.\n\nHOW: an EasyEcom field that applies to pharmacy sellers.\n\nUSE: not relevant to garment vendors; shown because the master is copied in full." },
  { key: 'dl_expiry', label: 'DL Expiry', kind: 'text', accessor: (r) => r.dl_expiry ?? '' },
  { key: 'fssai_number', label: 'FSSAI No.', kind: 'text', accessor: (r) => r.fssai_number ?? '' },
  { key: 'fssai_expiry', label: 'FSSAI Expiry', kind: 'text', accessor: (r) => r.fssai_expiry ?? '' },
  { key: 'freight_forwarding_days', label: 'Freight Fwd Days', kind: 'text', accessor: (r) => r.freight_forwarding_days ?? '' },
  { key: 'prep_days', label: 'Prep Days', kind: 'text', accessor: (r) => r.prep_days ?? '' },
  { key: 'shipment_intransit_days', label: 'In-Transit Days', kind: 'text', accessor: (r) => r.shipment_intransit_days ?? '' },
  { key: 'warehouse_checkin_time', label: 'WH Check-in', kind: 'text', accessor: (r) => r.warehouse_checkin_time ?? '' },
  { key: 'vendor_token', label: 'Vendor Token', kind: 'mono', accessor: (r) => r.vendor_token ?? '' },
  { key: 'api_token', label: 'API Token', kind: 'mono', accessor: (r) => r.api_token ?? '' },
  { key: 'synced_at', label: 'Synced', kind: 'text', accessor: (r) => date(r.synced_at), info: "WHAT: when this row was last refreshed.\n\nHOW: the time of the last sync from BigQuery.\n\nUSE: if it is old, check Sync Health." },
];

export function VendorMasterClient({
  rows,
  deboarded = {},
}: {
  rows: EeVendorMasterRow[];
  /** Approved de-boardings by upper-cased code (from the dashboard's own workflow). */
  deboarded?: Record<string, DeboardedVendor>;
}) {
  // The master is EasyEcom's table as-is; the one dashboard-side fact worth showing on it
  // is whether the team has decided to stop working with the vendor. Goes right after
  // Active, because that is the question it answers.
  const columns = useMemo<Column<EeVendorMasterRow>[]>(() => {
    const flagOf = (r: EeVendorMasterRow) => deboarded[(r.vendor_code ?? '').trim().toUpperCase()];
    const col: Column<EeVendorMasterRow> = {
      key: 'deboarded',
      label: 'De-boarding',
      info: "WHAT: whether the team has decided to stop working with this vendor.\n\nHOW: a de-boarding request raised and approved on the Vendor De-Boarding page; the date is the approval date, hover for the reason.\n\nMIND: separate from EasyEcom's Active flag. The vendor stays listed everywhere with this mark — open POs still need finishing — and switching it off in EasyEcom is a manual step.",
      accessor: (r) => (flagOf(r) ? `De-boarded ${new Date(flagOf(r)!.approvedAt).toLocaleDateString('en-IN')}` : ''),
      render: (r) => {
        const f = flagOf(r);
        return f ? <DeboardedPill flag={f} /> : <span className="wf-subtle">—</span>;
      },
    };
    const at = COLS.findIndex((c) => c.key === 'active') + 1;
    return [...COLS.slice(0, at), col, ...COLS.slice(at)];
  }, [deboarded]);
  return (
    <>
      <Notice tone="info">
        The EasyEcom vendor master exactly as GCP holds it (Easyecom_Saadaa_vendors →
        sd_ee_vendor_master) — every field, no Google-Sheet data. Read-only.
      </Notice>
      <FilterTable
        rows={rows}
        columns={columns}
        rowKey={(r) => r.vendor_code ?? r.vendor_c_id ?? r.vendor_name ?? ''}
        defaultSource="easyecom"
        unit="vendors"
        searchPlaceholder="Vendor, code, email or term"
        emptyText="No vendors match your filters."
      />
    </>
  );
}
