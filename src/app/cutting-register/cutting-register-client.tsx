'use client';

import { useState, useTransition } from 'react';
import { reloadWithToast } from '@/lib/toast';
import { Check, Copy, ExternalLink, Link2, MessageCircle, Trash2 } from 'lucide-react';
import { generateDynamicLink, revokeDynamicLink, signCuttingApproval } from '@/lib/forms/actions';
import { Notice } from '@/components/forms/form-layout';
import { FilterTable, type Column } from '@/components/filter-table';
import type { CuttingRegister, DynamicLink } from '@/lib/forms/types';

const disp = (v: number | null) => (v == null ? '—' : String(v));
const fmtDate = (s: string | null) => (s ? s.slice(0, 10) : '—');

export function CuttingRegisterClient({
  entries,
  links,
  editable,
}: {
  entries: CuttingRegister[];
  links: DynamicLink[];
  editable: boolean;
}) {
  return (
    <>
      <Notice tone="info">
        Enter cutting data under <strong>Manual Data Ingestion → Cutting Register</strong> (UI Input or
        Bulk Update). This page is for sending a no-login capture link to vendors / field staff, and for
        the log of entries already recorded.
      </Notice>
      {editable && <LinkPanel />}
      <ActiveLinks links={links} editable={editable} />
      <EntriesTable entries={entries} />
    </>
  );
}

/** Generate a no-login data-capture link + share it (WhatsApp / copy). */
function LinkPanel() {
  const [po, setPo] = useState('');
  const [busy, start] = useTransition();
  const [err, setErr] = useState<string | null>(null);
  const [result, setResult] = useState<{ token: string; expiresAt: string; po: string } | null>(null);
  const [copied, setCopied] = useState(false);

  const origin = typeof window !== 'undefined' ? window.location.origin : '';
  const url = result ? `${origin}/fill/${result.token}` : '';
  const waText = result ? `Please fill the cutting register for PO ${result.po}: ${url}` : '';
  const waHref = `https://wa.me/?text=${encodeURIComponent(waText)}`;

  function generate() {
    setErr(null);
    setResult(null);
    setCopied(false);
    const fd = new FormData();
    fd.set('po_ref_num', po);
    start(async () => {
      const res = await generateDynamicLink(fd);
      if (res.ok) setResult({ token: res.token, expiresAt: res.expiresAt, po });
      else setErr(res.error);
    });
  }

  function copy() {
    void navigator.clipboard?.writeText(url);
    setCopied(true);
  }

  return (
    <div className="wf-form-panel wf-card">
      <h3 className="wf-card-title">Generate a data-entry link</h3>
      {err && <Notice tone="error">{err}</Notice>}
      <div className="wf-issue-row wf-issue-row-wrap">
        <input
          className="wf-add-select"
          value={po}
          placeholder="PO reference"
          onChange={(e) => setPo(e.target.value)}
        />
        <button type="button" className="wf-btn wf-btn-primary wf-btn-sm" disabled={busy || !po} onClick={generate}>
          <Link2 size={13} /> {busy ? 'Generating…' : 'Generate link'}
        </button>
      </div>
      {result && (
        <div className="wf-link-result">
          <code className="wf-link-url">{url}</code>
          <div className="wf-issue-row">
            <button type="button" className="wf-btn wf-btn-ghost wf-btn-sm" onClick={copy}>
              {copied ? <Check size={13} /> : <Copy size={13} />} {copied ? 'Copied' : 'Copy link'}
            </button>
            <a className="wf-btn wf-btn-ghost wf-btn-sm" href={waHref} target="_blank" rel="noopener noreferrer">
              <MessageCircle size={13} /> Share via WhatsApp
            </a>
            <span className="wf-subtle">Single-use · expires {fmtDate(result.expiresAt)}</span>
          </div>
        </div>
      )}
    </div>
  );
}

function ActiveLinks({ links, editable }: { links: DynamicLink[]; editable: boolean }) {
  const [busy, start] = useTransition();
  const active = links.filter((l) => l.is_active && !l.submitted_at);

  function revoke(id: number) {
    const fd = new FormData();
    fd.set('id', String(id));
    start(async () => {
      const res = await revokeDynamicLink(fd);
      if (res.ok) reloadWithToast();
    });
  }

  const statusOf = (l: DynamicLink) =>
    l.submitted_at ? 'submitted' : !l.is_active ? 'revoked' : new Date(l.expires_at) < new Date() ? 'expired' : 'active';

  return (
    <div className="table-panel wf-grid-panel">
      <div className="wf-card-title wf-table-head">Data-entry links</div>
      <div className="table-scroll">
        <table className="wf-grid">
          <thead>
            <tr><th>PO</th><th>Created by</th><th>Expires</th><th>Status</th><th aria-label="Actions" /></tr>
          </thead>
          <tbody>
            {links.map((l) => (
              <tr key={l.id}>
                <td className="mono">{l.po_ref_num}</td>
                <td className="wf-subtle">{l.created_by}</td>
                <td>{fmtDate(l.expires_at)}</td>
                <td><span className="wf-status">{statusOf(l)}</span></td>
                <td>
                  {editable && l.is_active && !l.submitted_at && (
                    <button type="button" className="wf-btn wf-btn-ghost wf-btn-sm" disabled={busy} onClick={() => revoke(l.id)}>
                      <Trash2 size={13} /> Revoke
                    </button>
                  )}
                </td>
              </tr>
            ))}
            {!links.length && <tr><td colSpan={5} className="wf-empty-cell">No links generated yet.</td></tr>}
          </tbody>
        </table>
      </div>
      {active.length > 0 && <p className="wf-subtle wf-pad-sm">{active.length} active link(s).</p>}
    </div>
  );
}

/** "View" button for an uploaded approval image — fetches a short-lived signed URL on click. */
function ApprovalCell({ path }: { path: string | null }) {
  const [busy, setBusy] = useState(false);
  if (!path) return <span className="wf-subtle">—</span>;
  async function open() {
    setBusy(true);
    try {
      const res = await signCuttingApproval(path!);
      if ('url' in res) window.open(res.url, '_blank', 'noopener,noreferrer');
    } finally {
      setBusy(false);
    }
  }
  return (
    <button type="button" className="wf-btn wf-btn-ghost wf-btn-sm" disabled={busy} onClick={open}>
      <ExternalLink size={12} /> {busy ? '…' : 'View'}
    </button>
  );
}

const ENTRY_COLS: Column<CuttingRegister>[] = [
  { key: 'cutting_date', label: 'Cut date', accessor: (e) => e.cutting_date ?? '', render: (e) => fmtDate(e.cutting_date) },
  { key: 'fabric_sku_code', label: 'Fabric SKU', kind: 'mono', render: (e) => e.fabric_sku_code ?? '—' },
  { key: 'po', label: 'PO ref', kind: 'mono', accessor: (e) => e.po_ref_num || e.po_number || '', render: (e) => e.po_ref_num || e.po_number || '—' },
  { key: 'vendor_code', label: 'Vendor', render: (e) => e.vendor_code ?? '—' },
  { key: 'item_code', label: 'Item', kind: 'mono', render: (e) => e.item_code ?? e.product_code ?? '—' },
  { key: 'cutting_qty', label: 'Cut qty', kind: 'num', render: (e) => disp(e.cutting_qty) },
  { key: 'avg_fabric_consumption_approved', label: 'Avg cons.', kind: 'num', render: (e) => disp(e.avg_fabric_consumption_approved) },
  { key: 'width_of_fabric', label: 'Width', render: (e) => e.width_of_fabric ?? '—' },
  { key: 'fabric_consumed', label: 'Consumed', kind: 'num', render: (e) => disp(e.fabric_consumed) },
  { key: 'cutting_approval_sheet', label: 'Approval', render: (e) => <ApprovalCell path={e.cutting_approval_sheet} /> },
  { key: 'remarks', label: 'Remarks', render: (e) => e.remarks ?? '—' },
  { key: 'submitted_via', label: 'Via', render: (e) => (e.submitted_via === 'dynamic_link' ? 'link' : e.submitted_via) },
  { key: 'by', label: 'By', accessor: (e) => e.submitted_by_name || e.submitted_by_email || '', render: (e) => e.submitted_by_name || e.submitted_by_email || '—' },
];

function EntriesTable({ entries }: { entries: CuttingRegister[] }) {
  return (
    <div>
      <div className="wf-card-title wf-table-head">Cutting entries</div>
      <FilterTable
        rows={entries}
        columns={ENTRY_COLS}
        rowKey={(e) => String(e.id)}
        defaultSource="bigquery"
        unit="entries"
        searchPlaceholder="fabric, PO, vendor, item, person…"
        emptyText="No cutting entries yet."
        download={{ filename: 'cutting-entries' }}
      />
    </div>
  );
}
