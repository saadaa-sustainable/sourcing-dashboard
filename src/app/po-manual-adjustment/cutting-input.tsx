'use client';

import { useEffect, useState, useTransition } from 'react';
import { reloadWithToast } from '@/lib/toast';
import { Save, Upload, FileUp } from 'lucide-react';
import { searchPos, loadPoItems, saveCuttingRegister, bulkSaveCuttingRegister } from '@/lib/forms/actions';
import { createClient } from '@/lib/supabase/client';
import { Field, Notice } from '@/components/forms/form-layout';
import type { CuttingItemOption, CuttingPoOption } from '@/lib/forms/types';

/* ============================ UI Input ============================ */
/**
 * Cutting entry, PO-first: pick the PO → pick the Item → Vendor code/name and Fabric SKU
 * auto-fetch → fill the cutting figures + upload the signed approval image. Saves to
 * Supabase and flows to the warehouse BigQuery table.
 */
export function CuttingRegisterInput({ editable }: { editable: boolean }) {
  const [poQ, setPoQ] = useState('');
  const [poOpts, setPoOpts] = useState<CuttingPoOption[]>([]);
  const [poOpen, setPoOpen] = useState(false);
  const [po, setPo] = useState<CuttingPoOption | null>(null);

  const [items, setItems] = useState<CuttingItemOption[]>([]);
  const [itemCode, setItemCode] = useState('');

  const [date, setDate] = useState('');
  const [cutQty, setCutQty] = useState('');
  const [avg, setAvg] = useState('');
  const [width, setWidth] = useState('');
  const [consumed, setConsumed] = useState('');
  const [remarks, setRemarks] = useState('');

  const [fileName, setFileName] = useState('');
  const [approvalPath, setApprovalPath] = useState('');
  const [uploading, setUploading] = useState(false);

  const [busy, start] = useTransition();
  const [err, setErr] = useState<string | null>(null);

  // PO search (debounced). Also fetches an initial page when focused with an empty box.
  useEffect(() => {
    if (!poOpen) return;
    const t = setTimeout(() => { void searchPos(poQ).then(setPoOpts); }, 250);
    return () => clearTimeout(t);
  }, [poQ, poOpen]);

  const selectedItem = items.find((i) => i.item_code === itemCode) ?? null;
  const fabric = selectedItem?.fabric_sku_code ?? '';

  function pickPo(o: CuttingPoOption) {
    setPo(o);
    setPoOpen(false);
    setPoQ(o.po_number || o.po_ref_num);
    setItemCode('');
    setItems([]);
    void loadPoItems(o.po_ref_num).then(setItems);
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
      if (error) { setErr(`Image upload failed: ${error.message}`); setFileName(''); setApprovalPath(''); }
      else setApprovalPath(path);
    } catch {
      setErr('Image upload failed.'); setFileName(''); setApprovalPath('');
    } finally {
      setUploading(false);
    }
  }

  const canSave = editable && !!po && !uploading && (cutQty !== '' || consumed !== '');

  function save() {
    setErr(null);
    const fd = new FormData();
    fd.set('po_ref_num', po?.po_ref_num ?? '');
    fd.set('po_number', po?.po_number ?? '');
    fd.set('vendor_code', po?.vendor_code ?? '');
    fd.set('fabric_sku_code', fabric);
    fd.set('item_code', itemCode);
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

  if (!editable) return <Notice tone="info">You have view-only access — ask an admin for edit rights to add cutting entries.</Notice>;

  return (
    <div className="wf-form-panel wf-card">
      {err && <Notice tone="error">{err}</Notice>}
      <div className="wf-form-grid">
        {/* 1 — PO */}
        <Field label="PO number" hint="search by PO number or vendor">
          <div className="wf-async-picker">
            <input
              value={poQ}
              placeholder="search PO / vendor…"
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

        {/* 2 — Item (auto-populated from the PO) */}
        <Field label="Item code" hint={po ? 'items on this PO' : 'pick a PO first'}>
          <select value={itemCode} disabled={!po} onChange={(e) => setItemCode(e.target.value)}>
            <option value="">{po ? (items.length ? '— pick item —' : 'no items found') : '—'}</option>
            {items.map((it) => (
              <option key={it.item_code} value={it.item_code}>
                {it.item_code}{it.description ? ` · ${it.description}` : ''}
              </option>
            ))}
          </select>
        </Field>

        {/* 3 — Auto-fetched from the PO / item */}
        <Field label="Vendor code"><input value={po?.vendor_code ?? ''} readOnly disabled /></Field>
        <Field label="Vendor name"><input value={po?.vendor_name ?? ''} readOnly disabled /></Field>
        <Field label="Fabric SKU" hint="auto from item master (dyed fabric)"><input value={fabric} readOnly disabled /></Field>

        {/* 4 — Cutting figures */}
        <Field label="Date of cutting"><input type="date" value={date} onChange={(e) => setDate(e.target.value)} /></Field>
        <Field label="Cutting qty"><input type="number" min={0} step="1" value={cutQty} onChange={(e) => setCutQty(e.target.value)} /></Field>
        <Field label="Avg fabric consumption approved"><input type="number" min={0} step="0.001" value={avg} onChange={(e) => setAvg(e.target.value)} /></Field>
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

/* ============================ Bulk Update ============================ */

const TEMPLATE_HEADERS = [
  'DATE OF CUTTING', 'Vendor Code', 'PO NUMBER', 'FABRIC SKU CODE', 'ITEM CODE', 'Cutting Qty',
  'AVG FABRIC CONSUMPTION APPROVED', 'Width of fabric', 'Cutting Approval Sheet/Image', 'Remarks of cutting', 'Fabric Consumed',
];

const FIELD_FOR_HEADER: { key: string; match: (h: string) => boolean }[] = [
  { key: 'date_of_cutting', match: (h) => h.includes('date of cutting') },
  { key: 'vendor_code', match: (h) => h.includes('vendor code') },
  { key: 'po_number', match: (h) => h.includes('po number') || h === 'po' },
  { key: 'fabric_sku_code', match: (h) => h.includes('fabric sku') },
  { key: 'item_code', match: (h) => h.includes('item code') },
  { key: 'cutting_qty', match: (h) => h.includes('cutting qty') },
  { key: 'avg_fabric_consumption_approved', match: (h) => h.includes('avg fabric consumption') },
  { key: 'width_of_fabric', match: (h) => h.includes('width of fabric') },
  { key: 'cutting_approval_sheet', match: (h) => h.includes('cutting approval') },
  { key: 'remarks_of_cutting', match: (h) => h.includes('remarks') },
  { key: 'fabric_consumed', match: (h) => h.includes('fabric consumed') },
];

// Minimal RFC-4180-ish CSV parser (handles quoted fields with commas/quotes/newlines).
function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = '';
  let inQuotes = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inQuotes) {
      if (c === '"') { if (text[i + 1] === '"') { field += '"'; i++; } else inQuotes = false; }
      else field += c;
    } else if (c === '"') inQuotes = true;
    else if (c === ',') { row.push(field); field = ''; }
    else if (c === '\n') { row.push(field); rows.push(row); row = []; field = ''; }
    else if (c !== '\r') field += c;
  }
  if (field.length || row.length) { row.push(field); rows.push(row); }
  return rows.filter((r) => r.some((c) => c.trim() !== ''));
}

const HINT_TOKENS = new Set(['auto', 'manual', 'i/p', 'input']);

export function CuttingBulkUpdate({ editable }: { editable: boolean }) {
  const [fileName, setFileName] = useState('');
  const [rows, setRows] = useState<Record<string, string>[]>([]);
  const [parseErr, setParseErr] = useState<string | null>(null);
  const [busy, start] = useTransition();
  const [err, setErr] = useState<string | null>(null);

  async function onFile(e: React.ChangeEvent<HTMLInputElement>) {
    const f = e.target.files?.[0];
    if (!f) return;
    setErr(null); setParseErr(null); setRows([]); setFileName(f.name);
    try {
      const text = await f.text();
      const table = parseCsv(text);
      if (table.length < 2) { setParseErr('The file has no data rows.'); return; }
      const headers = table[0].map((h) => h.trim().toLowerCase());
      const colKey: (string | null)[] = headers.map((h) => FIELD_FOR_HEADER.find((f2) => f2.match(h))?.key ?? null);
      if (!colKey.some((k) => k === 'po_number')) { setParseErr('Could not find a "PO NUMBER" column. Use the template headers.'); return; }
      const parsed: Record<string, string>[] = [];
      for (let r = 1; r < table.length; r++) {
        const obj: Record<string, string> = {};
        table[r].forEach((cell, c) => { const k = colKey[c]; if (k) obj[k] = cell.trim(); });
        const po = (obj.po_number ?? '').trim();
        if (!po || HINT_TOKENS.has(po.toLowerCase())) continue; // skip blanks + the template hint row
        parsed.push(obj);
      }
      if (!parsed.length) { setParseErr('No data rows with a PO number were found.'); return; }
      setRows(parsed);
    } catch {
      setParseErr('Could not read that file.');
    }
  }

  function importRows() {
    setErr(null);
    const fd = new FormData();
    fd.set('rows', JSON.stringify(rows));
    start(async () => {
      const res = await bulkSaveCuttingRegister(fd);
      if (res.ok) reloadWithToast(res.message);
      else setErr(res.error);
    });
  }

  if (!editable) return <Notice tone="info">You have view-only access — ask an admin for edit rights to import cutting entries.</Notice>;

  const preview = rows.slice(0, 8);

  return (
    <div className="wf-form-panel wf-card">
      {err && <Notice tone="error">{err}</Notice>}
      <p className="wf-subtle">
        Upload a CSV using the cutting-register template headers. Each row needs a <strong>PO NUMBER</strong>;
        the rest map by column name. Rows import to Supabase and sync to BigQuery within ~5 minutes.
      </p>
      <p className="wf-subtle" style={{ fontSize: 12 }}>Columns: {TEMPLATE_HEADERS.join(' · ')}</p>

      <div className="wf-issue-row wf-issue-row-wrap">
        <label className="wf-btn wf-btn-ghost wf-btn-sm wf-file-btn">
          <FileUp size={13} /> {fileName || 'Choose CSV file'}
          <input type="file" accept=".csv,text/csv" hidden onChange={onFile} />
        </label>
        {rows.length > 0 && (
          <button type="button" className="wf-btn wf-btn-primary wf-btn-sm" disabled={busy} onClick={importRows}>
            {busy ? 'Importing…' : `Import ${rows.length} row${rows.length === 1 ? '' : 's'}`}
          </button>
        )}
      </div>

      {parseErr && <Notice tone="error">{parseErr}</Notice>}

      {rows.length > 0 && (
        <div className="table-scroll" style={{ marginTop: 12 }}>
          <table className="wf-grid">
            <thead>
              <tr>
                <th>PO</th><th>Vendor</th><th>Fabric SKU</th><th>Item</th>
                <th className="num">Cut qty</th><th className="num">Consumed</th><th>Date</th>
              </tr>
            </thead>
            <tbody>
              {preview.map((r, i) => (
                <tr key={i}>
                  <td className="mono">{r.po_number ?? '—'}</td>
                  <td>{r.vendor_code ?? '—'}</td>
                  <td className="mono">{r.fabric_sku_code ?? '—'}</td>
                  <td className="mono">{r.item_code ?? '—'}</td>
                  <td className="num">{r.cutting_qty ?? '—'}</td>
                  <td className="num">{r.fabric_consumed ?? '—'}</td>
                  <td>{r.date_of_cutting ?? '—'}</td>
                </tr>
              ))}
            </tbody>
          </table>
          {rows.length > preview.length && <p className="wf-subtle wf-pad-sm">+ {rows.length - preview.length} more row(s)…</p>}
        </div>
      )}
    </div>
  );
}
