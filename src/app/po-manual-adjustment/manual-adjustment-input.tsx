'use client';

import { useEffect, useState, useTransition } from 'react';
import { reloadWithToast } from '@/lib/toast';
import { Save, CheckCircle2, Clock } from 'lucide-react';
import { searchPos, loadPoSkus, saveManualAdjustments, loadRecentManualAdjustments } from '@/lib/forms/actions';
import { Field, Notice } from '@/components/forms/form-layout';
import type { CuttingSkuOption, CuttingPoOption, ManualAdjustmentEntry } from '@/lib/forms/types';

/* ============================ UI Input ============================ */
/**
 * PO manual adjustment, PO-first: pick the PO → every SKU on it lists out → type the adjust
 * qty against as many SKUs as needed → Save pushes them all to BigQuery in one go. Mirrors
 * the cutting-register input (same PO picker), but as a per-SKU grid because a batch of
 * adjustments is normally several SKUs of one PO at once.
 */
export function ManualAdjustmentInput({ editable }: { editable: boolean }) {
  const [poQ, setPoQ] = useState('');
  const [poOpts, setPoOpts] = useState<CuttingPoOption[]>([]);
  const [poOpen, setPoOpen] = useState(false);
  const [po, setPo] = useState<CuttingPoOption | null>(null);

  const [skus, setSkus] = useState<CuttingSkuOption[]>([]);
  const [loadingSkus, setLoadingSkus] = useState(false);
  const [qty, setQty] = useState<Record<string, string>>({});
  const [remarks, setRemarks] = useState('');

  const [recent, setRecent] = useState<ManualAdjustmentEntry[]>([]);
  const [busy, start] = useTransition();
  const [err, setErr] = useState<string | null>(null);
  const [ok, setOk] = useState<string | null>(null);

  // PO search (debounced). Also fetches an initial page when focused with an empty box.
  useEffect(() => {
    if (!poOpen) return;
    const t = setTimeout(() => { void searchPos(poQ).then(setPoOpts); }, 250);
    return () => clearTimeout(t);
  }, [poQ, poOpen]);

  // Recent dashboard entries (with BigQuery sync state) — fetched on mount and after each save.
  useEffect(() => { void loadRecentManualAdjustments().then(setRecent); }, []);

  const poType = po ? (po.po_ref_num.split('/')[1] ?? '').toUpperCase() : '';

  function pickPo(o: CuttingPoOption) {
    setPo(o);
    setPoOpen(false);
    setPoQ(o.po_ref_num || o.po_number || '');
    setSkus([]);
    setQty({});
    setLoadingSkus(true);
    void loadPoSkus(o.po_ref_num).then((s) => { setSkus(s); setLoadingSkus(false); });
  }

  const filled = skus.filter((s) => (qty[s.sku] ?? '').trim() !== '');
  const canSave = editable && !!po && filled.length > 0 && !busy;

  function save() {
    setErr(null);
    setOk(null);
    const fd = new FormData();
    fd.set('po_ref_num', po?.po_ref_num ?? '');
    fd.set('remarks', remarks);
    fd.set('rows', JSON.stringify(filled.map((s) => ({ sku_code: s.sku, manual_adjust_qty: qty[s.sku].trim() }))));
    start(async () => {
      const res = await saveManualAdjustments(fd);
      if (res.ok) {
        setOk(res.message ?? 'Saved.');
        setQty({});
        setRemarks('');
        void loadRecentManualAdjustments().then(setRecent);
        reloadWithToast(res.message ?? 'Saved.');
      } else {
        setErr(res.error);
      }
    });
  }

  if (!editable) return <Notice tone="info">You have view-only access — ask an admin for edit rights to enter adjustments.</Notice>;

  return (
    <div className="wf-stack">
      <div className="wf-form-panel wf-card">
        {err && <Notice tone="error">{err}</Notice>}
        {ok && <Notice tone="ok">{ok}</Notice>}
        <div className="wf-form-grid">
          {/* 1 — PO */}
          <Field label="PO reference" hint="search by PO reference or vendor">
            <div className="wf-async-picker">
              <input
                value={poQ}
                placeholder="search PO reference / vendor…"
                onChange={(e) => { setPoQ(e.target.value); setPo(null); setSkus([]); setQty({}); setPoOpen(true); }}
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

          {/* 2 — Auto from the PO */}
          <Field label="PO type" hint="auto from the PO reference"><input value={poType} readOnly disabled /></Field>
          <Field label="Vendor code"><input value={po?.vendor_code ?? ''} readOnly disabled /></Field>
          <Field label="Vendor name"><input value={po?.vendor_name ?? ''} readOnly disabled /></Field>
          <Field label="Remarks" hint="optional, applies to every SKU saved in this batch">
            <input value={remarks} onChange={(e) => setRemarks(e.target.value)} />
          </Field>
        </div>

        {/* 3 — SKU grid: one row per SKU on the PO; fill the ones being adjusted */}
        {po && (
          <div className="table-scroll" style={{ marginTop: 12 }}>
            <table className="wf-grid">
              <thead>
                <tr>
                  <th>SKU</th>
                  <th>Item</th>
                  <th>Size</th>
                  <th>Description</th>
                  <th style={{ width: 140 }}>Adjust qty (±)</th>
                </tr>
              </thead>
              <tbody>
                {loadingSkus && (
                  <tr><td colSpan={5} className="wf-subtle">Loading SKUs…</td></tr>
                )}
                {!loadingSkus && skus.length === 0 && (
                  <tr><td colSpan={5} className="wf-subtle">No SKUs found on this PO.</td></tr>
                )}
                {skus.map((s) => (
                  <tr key={s.sku}>
                    <td className="mono">{s.sku}</td>
                    <td>{s.item_code}</td>
                    <td>{s.size ?? '—'}</td>
                    <td className="wf-subtle">{s.description ?? ''}</td>
                    <td>
                      <input
                        type="number"
                        step="1"
                        inputMode="numeric"
                        placeholder="0"
                        value={qty[s.sku] ?? ''}
                        onChange={(e) => setQty((q) => ({ ...q, [s.sku]: e.target.value }))}
                        style={{ width: '100%' }}
                      />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}

        <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginTop: 12 }}>
          <button type="button" className="wf-btn wf-btn-primary wf-btn-sm" disabled={!canSave} onClick={save}>
            <Save size={13} /> {busy ? 'Saving…' : filled.length > 1 ? `Save ${filled.length} adjustments` : 'Save adjustment'}
          </button>
          {po && filled.length === 0 && (
            <span className="wf-subtle" style={{ fontSize: 12 }}>
              Type a quantity against the SKUs to adjust (negative to reduce).
            </span>
          )}
        </div>
      </div>

      {/* Recent dashboard entries + their BigQuery sync status */}
      <div className="wf-card">
        <div style={{ fontWeight: 600, marginBottom: 8 }}>Recent entries from the dashboard</div>
        {recent.length === 0 ? (
          <div className="wf-subtle">No adjustments entered from the dashboard yet.</div>
        ) : (
          <div className="table-scroll">
            <table className="wf-grid">
              <thead>
                <tr>
                  <th>Entered</th><th>PO</th><th>SKU</th><th>Adjust qty</th><th>PO type</th><th>By</th><th>BigQuery</th>
                </tr>
              </thead>
              <tbody>
                {recent.map((r) => (
                  <tr key={r.id}>
                    <td>{String(r.created_at).replace('T', ' ').slice(0, 16)}</td>
                    <td className="mono">{r.po_ref_num}</td>
                    <td className="mono">{r.sku_code}</td>
                    <td style={{ textAlign: 'right' }}>{r.manual_adjust_qty > 0 ? `+${r.manual_adjust_qty}` : r.manual_adjust_qty}</td>
                    <td>{r.po_type ?? '—'}</td>
                    <td>{r.submitted_by_email ?? '—'}</td>
                    <td>
                      {r.bq_synced_at
                        ? <span className="wf-subtle" title={`Landed ${String(r.bq_synced_at).replace('T', ' ').slice(0, 16)}`}><CheckCircle2 size={13} style={{ verticalAlign: '-2px', color: '#4f7c4d' }} /> synced</span>
                        : <span className="wf-subtle" title="Will sync within ~5 minutes"><Clock size={13} style={{ verticalAlign: '-2px' }} /> pending</span>}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  );
}
