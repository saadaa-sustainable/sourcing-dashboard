'use client';

import { useState, useTransition } from 'react';
import { reloadWithToast } from '@/lib/toast';
import { Check, Copy, Link2, MessageCircle, Save, Trash2 } from 'lucide-react';
import {
  generateDynamicLink,
  revokeDynamicLink,
  saveCuttingRegister,
} from '@/lib/forms/actions';
import { Field, Notice } from '@/components/forms/form-layout';
import { FilterTable, type Column } from '@/components/filter-table';
import type { CuttingRegister, DynamicLink, ProductBom } from '@/lib/forms/types';

// product_code is encoded in po_ref_num: FY.../<TYPE>/<PRODUCT>/<VENDOR>-<SEQ>.
const productFromPo = (po: string) => po.split('/')[2]?.trim() || '';
const disp = (v: number | null) => (v == null ? '—' : String(v));
const fmtDate = (s: string | null) => (s ? s.slice(0, 10) : '—');

export function CuttingRegisterClient({
  entries,
  links,
  bom,
  editable,
}: {
  entries: CuttingRegister[];
  links: DynamicLink[];
  bom: Record<string, ProductBom>;
  editable: boolean;
}) {
  return (
    <>
      {editable && <EntryPanel bom={bom} />}
      {editable && <LinkPanel />}

      <ActiveLinks links={links} editable={editable} />
      <EntriesTable entries={entries} />
    </>
  );
}

/** Authenticated cutting entry — shows the BOM standard beside the actual input. */
function EntryPanel({ bom }: { bom: Record<string, ProductBom> }) {
  const [po, setPo] = useState('');
  const [actual, setActual] = useState('');
  const [date, setDate] = useState('');
  const [remarks, setRemarks] = useState('');
  const [busy, start] = useTransition();
  const [err, setErr] = useState<string | null>(null);

  const productCode = productFromPo(po);
  const std = productCode ? bom[productCode] : undefined;
  const bomQty = std?.bom_quantity ?? null;
  const actualNum = actual === '' ? null : Number(actual);
  const surplus = bomQty != null && actualNum != null ? Math.round((actualNum - bomQty) * 100) / 100 : null;

  function save() {
    setErr(null);
    const fd = new FormData();
    fd.set('po_ref_num', po);
    fd.set('actual_consumption_qty', actual);
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
        <Field label="PO reference" hint="product is read from the PO code">
          <input value={po} placeholder="FY26-27/FOB/SDRPT/VEND-01" onChange={(e) => setPo(e.target.value)} />
        </Field>
        <Field label="Product"><input value={productCode} readOnly disabled /></Field>
        <Field label="BOM standard" hint={std ? '' : productCode ? 'No BOM on file' : ''}>
          <input value={bomQty != null ? `${bomQty}${std?.bom_uom ? ' ' + std.bom_uom : ''}` : (productCode ? 'No BOM on file' : '—')} readOnly disabled />
        </Field>
        <Field label="Actual consumption">
          <input type="number" min={0} step="0.01" value={actual} onChange={(e) => setActual(e.target.value)} />
        </Field>
        <Field label="Surplus vs BOM" hint="actual − BOM">
          <input value={surplus != null ? String(surplus) : '—'} readOnly disabled />
        </Field>
        <Field label="Cutting date">
          <input type="date" value={date} onChange={(e) => setDate(e.target.value)} />
        </Field>
        <Field label="Remarks">
          <input value={remarks} onChange={(e) => setRemarks(e.target.value)} />
        </Field>
        <button type="button" className="wf-btn wf-btn-primary wf-btn-sm" disabled={busy || !po || actual === ''} onClick={save}>
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
  const waText = result
    ? `Please fill the cutting register for PO ${result.po}: ${url}`
    : '';
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

const surplusOf = (e: CuttingRegister) =>
  e.bom_standard_qty != null && e.actual_consumption_qty != null
    ? Math.round((e.actual_consumption_qty - e.bom_standard_qty) * 100) / 100
    : null;

const ENTRY_COLS: Column<CuttingRegister>[] = [
  { key: 'po_ref_num', label: 'PO', kind: 'mono' },
  { key: 'product_code', label: 'Product', render: (e) => e.product_code ?? '—' },
  {
    key: 'bom_standard_qty', label: 'BOM', kind: 'num',
    render: (e) => (e.bom_standard_qty != null ? `${e.bom_standard_qty}${e.bom_uom ? ' ' + e.bom_uom : ''}` : <span className="wf-subtle">No BOM</span>),
  },
  { key: 'actual_consumption_qty', label: 'Actual', kind: 'num', render: (e) => disp(e.actual_consumption_qty) },
  {
    key: 'surplus', label: 'Surplus', kind: 'num',
    accessor: (e) => surplusOf(e),
    render: (e) => { const s = surplusOf(e); return <span className={s != null && s > 0 ? 'wf-error-text' : undefined}>{s != null ? s : '—'}</span>; },
  },
  { key: 'cutting_date', label: 'Cut date', accessor: (e) => e.cutting_date ?? '', render: (e) => fmtDate(e.cutting_date) },
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
        unit="entries"
        searchPlaceholder="PO, product, person…"
        emptyText="No cutting entries yet."
        download={{ filename: 'cutting-entries' }}
      />
    </div>
  );
}
