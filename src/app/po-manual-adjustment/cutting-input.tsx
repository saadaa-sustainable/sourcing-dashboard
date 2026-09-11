'use client';

import { useEffect, useState, useTransition } from 'react';
import { reloadWithToast } from '@/lib/toast';
import { Save, Upload, ExternalLink } from 'lucide-react';
import { searchPos, loadPoSkus, saveCuttingRegister } from '@/lib/forms/actions';
import { createClient } from '@/lib/supabase/client';
import { Field, Notice } from '@/components/forms/form-layout';
import type { CuttingSkuOption, CuttingPoOption } from '@/lib/forms/types';

/* ============================ UI Input ============================ */
/**
 * Cutting entry, PO-first: pick the PO → pick the SKU → item code, fabric SKU, size and
 * vendor auto-derive → fill the cutting figures + upload the signed approval image.
 */
export function CuttingRegisterInput({ editable }: { editable: boolean }) {
  const [poQ, setPoQ] = useState('');
  const [poOpts, setPoOpts] = useState<CuttingPoOption[]>([]);
  const [poOpen, setPoOpen] = useState(false);
  const [po, setPo] = useState<CuttingPoOption | null>(null);

  const [skus, setSkus] = useState<CuttingSkuOption[]>([]);
  const [skuSel, setSkuSel] = useState('');

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

  // Everything below the SKU derives from the chosen SKU.
  const selected = skus.find((s) => s.sku === skuSel) ?? null;
  const itemCode = selected?.item_code ?? '';
  const fabric = selected?.fabric_sku_code ?? '';
  const size = selected?.size ?? '';

  function pickPo(o: CuttingPoOption) {
    setPo(o);
    setPoOpen(false);
    setPoQ(o.po_ref_num || o.po_number || '');
    setSkuSel('');
    setSkus([]);
    void loadPoSkus(o.po_ref_num).then(setSkus);
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

  const canSave = editable && !!po && !!skuSel && !uploading && (cutQty !== '' || consumed !== '');

  function save() {
    setErr(null);
    const fd = new FormData();
    fd.set('po_ref_num', po?.po_ref_num ?? '');
    fd.set('po_number', po?.po_number ?? '');
    fd.set('vendor_code', po?.vendor_code ?? '');
    fd.set('fabric_sku_code', fabric);
    fd.set('item_code', itemCode);
    fd.set('size', size);
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
        <Field label="PO reference" hint="search by PO reference or vendor">
          <div className="wf-async-picker">
            <input
              value={poQ}
              placeholder="search PO reference / vendor…"
              onChange={(e) => { setPoQ(e.target.value); setPo(null); setPoOpen(true); }}
              onFocus={() => setPoOpen(true)}
              onBlur={() => setTimeout(() => setPoOpen(false), 150)}
            />
            {poOpen && poOpts.length > 0 && (
              <ul className="wf-async-list">
                {poOpts.map((o) => (
                  <li key={o.po_ref_num}>
                    <button type="button" onMouseDown={(e) => { e.preventDefault(); pickPo(o); }}>
                      <span className="mono">{o.po_ref_num || o.po_number}</span>
                      <span className="wf-subtle"> · {o.vendor_code ?? ''}{o.vendor_name ? ` (${o.vendor_name})` : ''}</span>
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </div>
        </Field>

        {/* 2 — SKU (the PO's SKUs) */}
        <Field label="SKU" hint={po ? 'pick the SKU from this PO' : 'pick a PO first'}>
          <select value={skuSel} disabled={!po} onChange={(e) => setSkuSel(e.target.value)}>
            <option value="">{po ? (skus.length ? '— pick SKU —' : 'no SKUs found') : '—'}</option>
            {skus.map((s) => (
              <option key={s.sku} value={s.sku}>
                {s.sku}{s.description ? ` · ${s.description}` : ''}
              </option>
            ))}
          </select>
        </Field>

        {/* 3 — Auto-derived from the SKU / PO */}
        <Field label="Item code" hint="auto from SKU (style code)"><input value={itemCode} readOnly disabled /></Field>
        <Field label="Fabric SKU" hint="auto from item master (dyed fabric)"><input value={fabric} readOnly disabled /></Field>
        <Field label="Size" hint="auto from SKU"><input value={size} readOnly disabled /></Field>
        <Field label="Vendor code"><input value={po?.vendor_code ?? ''} readOnly disabled /></Field>
        <Field label="Vendor name"><input value={po?.vendor_name ?? ''} readOnly disabled /></Field>

        {/* 4 — Cutting figures */}
        <Field label="Date of cutting"><input type="date" value={date} onChange={(e) => setDate(e.target.value)} /></Field>
        <Field label="Cutting qty"><input type="number" min={0} step="1" value={cutQty} onChange={(e) => setCutQty(e.target.value)} /></Field>
        <Field label="Avg fabric consumption approved"><input type="number" min={0} step="0.001" value={avg} onChange={(e) => setAvg(e.target.value)} /></Field>
        <Field label="Width of fabric"><input value={width} placeholder='e.g. 58"' onChange={(e) => setWidth(e.target.value)} /></Field>
        <Field label="Fabric Consumed (meter)"><input type="number" min={0} step="0.001" value={consumed} onChange={(e) => setConsumed(e.target.value)} /></Field>
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
/** Bulk cutting-register submission goes through the external ingestion portal, which syncs
 *  back into these tables. (The in-app CSV upload was removed by request.) */
export function CuttingBulkUpdate({ portalUrl }: { portalUrl: string }) {
  return (
    <div className="wf-form-panel wf-card">
      <div className="wf-notice wf-notice-info">
        <strong>Bulk submit via the ingestion portal:</strong>{' '}
        <a href={portalUrl} target="_blank" rel="noopener noreferrer">
          Open ingestion portal <ExternalLink size={12} style={{ verticalAlign: '-1px' }} />
        </a>
        {' '}— submit the cutting-register data there in bulk; it syncs back into these tables.
      </div>
    </div>
  );
}
