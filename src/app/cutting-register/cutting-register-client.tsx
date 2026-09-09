'use client';

import { useEffect, useState, useTransition } from 'react';
import { reloadWithToast } from '@/lib/toast';
import { Check, Copy, ExternalLink, Link2, MessageCircle, Save, Trash2, Upload } from 'lucide-react';
import {
  generateDynamicLink,
  revokeDynamicLink,
  saveCuttingRegister,
  searchFabricSkus,
  loadPosForFabric,
  loadPoItems,
  signCuttingApproval,
} from '@/lib/forms/actions';
import { createClient } from '@/lib/supabase/client';
import { Field, Notice } from '@/components/forms/form-layout';
import { FilterTable, type Column } from '@/components/filter-table';
import type {
  CuttingRegister,
  CuttingItemOption,
  CuttingPoOption,
  DynamicLink,
} from '@/lib/forms/types';

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
      {editable && <EntryPanel />}
      {editable && <LinkPanel />}

      <ActiveLinks links={links} editable={editable} />
      <EntriesTable entries={entries} />
    </>
  );
}

/**
 * Template entry flow: pick the Fabric SKU → pick a PO that contains it (Vendor / PO fill
 * in) → pick the item on that PO → fill the cutting figures + upload the signed approval
 * sheet. Saves to Supabase and flows to the warehouse BigQuery table.
 */
function EntryPanel() {
  // Fabric SKU (type-ahead)
  const [fabric, setFabric] = useState('');
  const [fabricQ, setFabricQ] = useState('');
  const [fabricOpts, setFabricOpts] = useState<string[]>([]);
  const [fabricOpen, setFabricOpen] = useState(false);

  // PO (searchable, filtered by fabric)
  const [po, setPo] = useState<CuttingPoOption | null>(null);
  const [poQ, setPoQ] = useState('');
  const [poOpts, setPoOpts] = useState<CuttingPoOption[]>([]);
  const [poOpen, setPoOpen] = useState(false);

  // Item on the PO
  const [items, setItems] = useState<CuttingItemOption[]>([]);
  const [item, setItem] = useState('');

  // Cutting figures
  const [date, setDate] = useState('');
  const [cutQty, setCutQty] = useState('');
  const [avg, setAvg] = useState('');
  const [width, setWidth] = useState('');
  const [consumed, setConsumed] = useState('');
  const [remarks, setRemarks] = useState('');

  // Signed approval image (uploaded to storage; we keep the path)
  const [fileName, setFileName] = useState('');
  const [approvalPath, setApprovalPath] = useState('');
  const [uploading, setUploading] = useState(false);

  const [busy, start] = useTransition();
  const [err, setErr] = useState<string | null>(null);

  // Fabric SKU type-ahead (debounced).
  useEffect(() => {
    const t = setTimeout(() => {
      void searchFabricSkus(fabricQ).then(setFabricOpts);
    }, 250);
    return () => clearTimeout(t);
  }, [fabricQ]);

  // PO search — reruns when the fabric or the PO query changes.
  useEffect(() => {
    if (!fabric) {
      setPoOpts([]);
      return;
    }
    const t = setTimeout(() => {
      void loadPosForFabric(fabric, poQ).then(setPoOpts);
    }, 250);
    return () => clearTimeout(t);
  }, [fabric, poQ]);

  function pickFabric(f: string) {
    setFabric(f);
    setFabricQ(f);
    setFabricOpen(false);
    setPo(null);
    setPoQ('');
    setItems([]);
    setItem('');
  }

  function pickPo(o: CuttingPoOption) {
    setPo(o);
    setPoOpen(false);
    setPoQ(o.po_number || o.po_ref_num);
    setItem('');
    void loadPoItems(o.po_ref_num, fabric).then(setItems);
  }

  async function onFile(e: React.ChangeEvent<HTMLInputElement>) {
    const f = e.target.files?.[0];
    if (!f) return;
    setErr(null);
    setUploading(true);
    setFileName(f.name);
    try {
      const supabase = createClient();
      const ext = (f.name.split('.').pop() || 'bin').toLowerCase();
      const path = `cutting/${crypto.randomUUID()}.${ext}`;
      const { error } = await supabase.storage.from('cutting-approvals').upload(path, f, { upsert: false });
      if (error) {
        setErr(`Image upload failed: ${error.message}`);
        setFileName('');
        setApprovalPath('');
      } else {
        setApprovalPath(path);
      }
    } catch {
      setErr('Image upload failed.');
      setFileName('');
      setApprovalPath('');
    } finally {
      setUploading(false);
    }
  }

  const canSave = !!fabric && !!po && !uploading && (cutQty !== '' || consumed !== '');

  function save() {
    setErr(null);
    const fd = new FormData();
    fd.set('po_ref_num', po?.po_ref_num ?? '');
    fd.set('po_number', po?.po_number ?? '');
    fd.set('vendor_code', po?.vendor_code ?? '');
    fd.set('fabric_sku_code', fabric);
    fd.set('item_code', item);
    fd.set('cutting_qty', cutQty);
    fd.set('avg_fabric_consumption_approved', avg);
    fd.set('width_of_fabric', width);
    fd.set('fabric_consumed', consumed);
    fd.set('cutting_approval_sheet', approvalPath);
    fd.set('cutting_date', date);
    fd.set('remarks', remarks);
    start(async () => {
      const res = await saveCuttingRegister(fd);
      if (res.ok) reloadWithToast();
      else setErr(res.error);
    });
  }

  return (
    <div className="wf-form-panel wf-card">
      <h3 className="wf-card-title">Add a cutting entry</h3>
      {err && <Notice tone="error">{err}</Notice>}
      <div className="wf-form-grid">
        {/* 1 — Fabric SKU */}
        <Field label="Fabric SKU code" hint="type to search the dyed-fabric SKU (Item Master)">
          <div className="wf-async-picker">
            <input
              value={fabricQ}
              placeholder="e.g. 20CT/63/BL"
              onChange={(e) => { setFabricQ(e.target.value); setFabric(''); setFabricOpen(true); }}
              onFocus={() => setFabricOpen(true)}
              onBlur={() => setTimeout(() => setFabricOpen(false), 150)}
            />
            {fabricOpen && fabricOpts.length > 0 && (
              <ul className="wf-async-list">
                {fabricOpts.map((f) => (
                  <li key={f}><button type="button" onMouseDown={(e) => { e.preventDefault(); pickFabric(f); }}>{f}</button></li>
                ))}
              </ul>
            )}
          </div>
        </Field>

        {/* 2 — PO (filtered by fabric) */}
        <Field label="PO number" hint={fabric ? 'POs containing this fabric — search by PO or vendor' : 'pick a fabric SKU first'}>
          <div className="wf-async-picker">
            <input
              value={poQ}
              disabled={!fabric}
              placeholder={fabric ? 'search PO / vendor…' : '—'}
              onChange={(e) => { setPoQ(e.target.value); setPo(null); setPoOpen(true); }}
              onFocus={() => setPoOpen(true)}
              onBlur={() => setTimeout(() => setPoOpen(false), 150)}
            />
            {poOpen && poOpts.length > 0 && (
              <ul className="wf-async-list">
                {poOpts.map((o) => (
                  <li key={o.po_ref_num}>
                    <button type="button" onMouseDown={(e) => { e.preventDefault(); pickPo(o); }}>
                      <span className="mono">{o.po_number || o.po_ref_num}</span>
                      <span className="wf-subtle"> · {o.vendor_code ?? ''}{o.vendor_name ? ` (${o.vendor_name})` : ''}</span>
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </div>
        </Field>

        <Field label="Vendor code"><input value={po?.vendor_code ?? ''} readOnly disabled /></Field>

        {/* 3 — Item on the PO */}
        <Field label="Item code" hint={po ? 'garments on this PO using the fabric' : 'pick a PO first'}>
          <select value={item} disabled={!po} onChange={(e) => setItem(e.target.value)}>
            <option value="">{po ? '— pick item —' : '—'}</option>
            {items.map((it) => (
              <option key={it.item_code} value={it.item_code}>
                {it.item_code}{it.description ? ` · ${it.description}` : ''}
              </option>
            ))}
          </select>
        </Field>

        {/* 4 — Cutting figures */}
        <Field label="Date of cutting"><input type="date" value={date} onChange={(e) => setDate(e.target.value)} /></Field>
        <Field label="Cutting qty"><input type="number" min={0} step="1" value={cutQty} onChange={(e) => setCutQty(e.target.value)} /></Field>
        <Field label="Avg fabric consumption approved" hint="the final approved avg consumption used"><input type="number" min={0} step="0.001" value={avg} onChange={(e) => setAvg(e.target.value)} /></Field>
        <Field label="Width of fabric"><input value={width} placeholder='e.g. 58"' onChange={(e) => setWidth(e.target.value)} /></Field>
        <Field label="Fabric consumed"><input type="number" min={0} step="0.001" value={consumed} onChange={(e) => setConsumed(e.target.value)} /></Field>
        <Field label="Remarks of cutting"><input value={remarks} onChange={(e) => setRemarks(e.target.value)} /></Field>

        {/* 5 — Signed approval image */}
        <Field label="Cutting approval sheet/image" hint="Saadaa sign mandatory">
          <label className="wf-btn wf-btn-ghost wf-btn-sm wf-file-btn">
            <Upload size={13} /> {uploading ? 'Uploading…' : approvalPath ? 'Replace image' : 'Upload image'}
            <input type="file" accept="image/*,application/pdf" hidden onChange={onFile} disabled={uploading} />
          </label>
          {approvalPath && <span className="wf-subtle"> {fileName} ✓</span>}
        </Field>

        <button type="button" className="wf-btn wf-btn-primary wf-btn-sm" disabled={busy || !canSave} onClick={save}>
          <Save size={13} /> {busy ? 'Saving…' : 'Save entry'}
        </button>
      </div>
    </div>
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
  { key: 'po', label: 'PO', kind: 'mono', accessor: (e) => e.po_number || e.po_ref_num, render: (e) => e.po_number || e.po_ref_num },
  { key: 'vendor_code', label: 'Vendor', render: (e) => e.vendor_code ?? '—' },
  { key: 'item_code', label: 'Item', kind: 'mono', render: (e) => e.item_code ?? e.product_code ?? '—' },
  { key: 'cutting_qty', label: 'Cut qty', kind: 'num', render: (e) => disp(e.cutting_qty) },
  { key: 'avg_fabric_consumption_approved', label: 'Avg cons.', kind: 'num', render: (e) => disp(e.avg_fabric_consumption_approved) },
  { key: 'width_of_fabric', label: 'Width', render: (e) => e.width_of_fabric ?? '—' },
  { key: 'fabric_consumed', label: 'Consumed', kind: 'num', render: (e) => disp(e.fabric_consumed) },
  { key: 'cutting_approval_sheet', label: 'Approval', render: (e) => <ApprovalCell path={e.cutting_approval_sheet} /> },
  { key: 'remarks', label: 'Remarks', render: (e) => e.remarks ?? '—' },
  { key: 'submitted_via', label: 'Via', render: (e) => (e.submitted_via === 'dynamic_link' ? 'link' : 'dashboard') },
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
