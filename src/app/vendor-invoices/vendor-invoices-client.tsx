'use client';

import { useState, useSyncExternalStore, useTransition } from 'react';
import { Check, Copy, ExternalLink, MessageCircle, Trash2 } from 'lucide-react';
import { FilterTable, type Column } from '@/components/filter-table';
import { Notice } from '@/components/forms/form-layout';
import { deleteVendorInvoice, signVendorInvoiceFile } from '@/lib/forms/actions';
import { reloadWithToast } from '@/lib/toast';
import type { VendorInvoice } from '@/lib/vendor-invoice';

const fmtDate = (s: string | null) => (s ? s.slice(0, 10) : '—');
const fmtStamp = (s: string) =>
  new Date(s).toLocaleString('en-IN', { day: '2-digit', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' });
const noSubscribe = () => () => {};
const inr = new Intl.NumberFormat('en-IN', { maximumFractionDigits: 2 });

export function VendorInvoicesClient({
  entries,
  vendorNames,
  isAdmin,
}: {
  entries: VendorInvoice[];
  vendorNames: Record<string, string>;
  isAdmin: boolean;
}) {
  const columns: Column<VendorInvoice>[] = [
    { key: 'created_at', label: 'Submitted', accessor: (e) => e.created_at, render: (e) => fmtStamp(e.created_at), filter: 'none', source: 'supabase' },
    { key: 'document_type', label: 'Document', source: 'supabase' },
    { key: 'po_ref_num', label: 'PO No.', kind: 'mono', source: 'supabase' },
    {
      key: 'vendor_code',
      label: 'Vendor',
      accessor: (e) => e.vendor_code ?? '',
      render: (e) =>
        e.vendor_code ? (
          <span title={vendorNames[e.vendor_code] || undefined}>
            {e.vendor_code}
            {vendorNames[e.vendor_code] ? <span className="wf-subtle"> · {vendorNames[e.vendor_code]}</span> : null}
          </span>
        ) : (
          '—'
        ),
      source: 'supabase',
    },
    { key: 'association', label: 'Association', source: 'supabase' },
    { key: 'po_type', label: 'PO type', accessor: (e) => e.po_type ?? '', source: 'supabase' },
    {
      key: 'doc_no',
      label: 'Invoice / ref. no.',
      kind: 'mono',
      accessor: (e) => e.invoice_number ?? e.reference_document_number ?? '',
      info: 'Invoice number for an invoice; the reference document number for a debit or credit note.',
      source: 'supabase',
    },
    {
      key: 'doc_date',
      label: 'Document date',
      accessor: (e) => e.invoice_date ?? e.note_date ?? '',
      render: (e) => fmtDate(e.invoice_date ?? e.note_date),
      filter: 'none',
      source: 'supabase',
    },
    { key: 'invoice_total_qty', label: 'Total qty', kind: 'num', source: 'supabase' },
    {
      key: 'invoice_value',
      label: 'Invoice value',
      kind: 'num',
      render: (e) => (e.invoice_value == null ? '—' : `₹${inr.format(e.invoice_value)}`),
      source: 'supabase',
    },
    { key: 'grn_number', label: 'GRN no.', kind: 'mono', accessor: (e) => e.grn_number ?? '', source: 'supabase' },
    { key: 'reference_challan_number', label: 'Challan no.', kind: 'mono', accessor: (e) => e.reference_challan_number ?? '', source: 'supabase' },
    { key: 'email', label: 'Email', source: 'supabase' },
    { key: 'file', label: 'PDF', accessor: (e) => e.file_name ?? '', render: (e) => <FileCell entry={e} />, filter: 'none', sortable: false },
    {
      key: 'submitted_via',
      label: 'Via',
      accessor: (e) => (e.submitted_via === 'public_link' ? 'Vendor link' : e.submitted_by_email ?? 'Dashboard'),
      source: 'supabase',
    },
  ];
  if (isAdmin)
    columns.push({ key: 'actions', label: '', render: (e) => <DeleteCell id={e.id} />, filter: 'none', sortable: false });

  return (
    <>
      <LinkPanel />
      <div>
        <div className="wf-card-title wf-table-head">Entries</div>
        <FilterTable
          rows={entries}
          columns={columns}
          rowKey={(e) => String(e.id)}
          defaultSource="supabase"
          unit="entries"
          searchPlaceholder="PO, vendor, invoice no., email…"
          emptyText="No entries yet. Share the link above with vendors."
          download={{ filename: 'vendor-invoices' }}
        />
      </div>
    </>
  );
}

/** The one open link vendors use (the Google Form's replacement). */
function LinkPanel() {
  const [copied, setCopied] = useState(false);
  // The full URL needs the browser's origin; the server render uses the bare path.
  const origin = useSyncExternalStore(noSubscribe, () => window.location.origin, () => '');
  const url = `${origin}/vendor-invoice`;
  const waText = `Please share the soft copy of your Invoice / Debit Note / Credit Note with SAADAA Accounts here: ${url}`;
  return (
    <div className="wf-form-panel wf-card">
      <h3 className="wf-card-title">Vendor link</h3>
      <Notice tone="info">
        One open link for every vendor, no login needed. Anyone with the link can submit, so share it only with
        vendors. Entries appear in the table below.
      </Notice>
      <div className="wf-link-result">
        <code className="wf-link-url">{url}</code>
        <div className="wf-issue-row">
          <button
            type="button"
            className="wf-btn wf-btn-ghost wf-btn-sm"
            onClick={() => {
              void navigator.clipboard?.writeText(url);
              setCopied(true);
            }}
          >
            {copied ? <Check size={13} /> : <Copy size={13} />} {copied ? 'Copied' : 'Copy link'}
          </button>
          <a className="wf-btn wf-btn-ghost wf-btn-sm" href={`https://wa.me/?text=${encodeURIComponent(waText)}`} target="_blank" rel="noopener noreferrer">
            <MessageCircle size={13} /> Share via WhatsApp
          </a>
          <a className="wf-btn wf-btn-ghost wf-btn-sm" href="/vendor-invoice" target="_blank" rel="noopener noreferrer">
            <ExternalLink size={13} /> Open the form
          </a>
        </div>
      </div>
    </div>
  );
}

/** Opens the PDF through a short-lived signed URL. */
function FileCell({ entry }: { entry: VendorInvoice }) {
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  async function open() {
    setBusy(true);
    setErr(null);
    try {
      const res = await signVendorInvoiceFile(entry.id);
      if ('url' in res) window.open(res.url, '_blank', 'noopener,noreferrer');
      else setErr(res.error);
    } finally {
      setBusy(false);
    }
  }
  return (
    <button type="button" className="wf-btn wf-btn-ghost wf-btn-sm" disabled={busy} onClick={open} title={err ?? entry.file_name ?? undefined}>
      <ExternalLink size={12} /> {busy ? '…' : err ? 'Retry' : 'View'}
    </button>
  );
}

function DeleteCell({ id }: { id: number }) {
  const [armed, setArmed] = useState(false);
  const [busy, start] = useTransition();
  if (!armed)
    return (
      <button type="button" className="wf-btn wf-btn-ghost wf-btn-sm" onClick={() => setArmed(true)} aria-label="Delete entry">
        <Trash2 size={12} />
      </button>
    );
  return (
    <button
      type="button"
      className="wf-btn wf-btn-danger wf-btn-sm"
      disabled={busy}
      onClick={() =>
        start(async () => {
          const res = await deleteVendorInvoice(id);
          if (res.ok) reloadWithToast(res.message ?? 'Deleted.');
          else setArmed(false);
        })
      }
    >
      {busy ? 'Deleting…' : 'Confirm delete'}
    </button>
  );
}
