'use client';

import { useMemo, useState } from 'react';
import { Notice } from '@/components/forms/form-layout';
import type { GcpProductMaster } from '@/lib/forms/types';

const fmt = new Intl.NumberFormat('en-IN', { maximumFractionDigits: 2 });
const PAGE = 50;
const norm = (v: string | null) => (v ?? '').trim().toLowerCase();

type Col = { key: keyof GcpProductMaster; label: string; kind: 'text' | 'mono' | 'num' };

const COLS: Col[] = [
  { key: 'sku', label: 'SKU', kind: 'mono' },
  { key: 'product_code', label: 'Product Code', kind: 'mono' },
  { key: 'product_variant', label: 'Variant', kind: 'mono' },
  { key: 'product_name', label: 'Product Name', kind: 'text' },
  { key: 'color', label: 'Colour', kind: 'text' },
  { key: 'size', label: 'Size', kind: 'text' },
  { key: 'product_state', label: 'Status', kind: 'text' },
  { key: 'weave_type', label: 'Weave', kind: 'text' },
  { key: 'category', label: 'Category', kind: 'text' },
  { key: 'gender', label: 'Gender', kind: 'text' },
  { key: 'item_category', label: 'Item Category', kind: 'text' },
  { key: 'sub_category', label: 'Sub-category', kind: 'text' },
  { key: 'rm_code', label: 'RM Code', kind: 'mono' },
  { key: 'dyed_fabric_sku', label: 'Dyed Fabric SKU', kind: 'mono' },
  { key: 'fabric_name', label: 'Fabric', kind: 'text' },
  { key: 'fabric_gsm', label: 'GSM', kind: 'text' },
  { key: 'fit_type', label: 'Fit', kind: 'text' },
  { key: 'age_group', label: 'Age Group', kind: 'text' },
  { key: 'season', label: 'Season', kind: 'text' },
  { key: 'replenishment_type', label: 'Replen. Type', kind: 'text' },
  { key: 'product_type', label: 'Product Type', kind: 'text' },
  { key: 'launch_date', label: 'Launch Date', kind: 'text' },
  { key: 'mrp', label: 'MRP', kind: 'num' },
  { key: 'cost', label: 'Cost', kind: 'num' },
];

function cell(row: GcpProductMaster, col: Col) {
  const v = row[col.key];
  if (v === null || v === undefined || v === '') return <span className="wf-subtle">—</span>;
  if (col.kind === 'num') return fmt.format(Number(v));
  return String(v);
}

export function ProductMasterClient({ products }: { products: GcpProductMaster[] }) {
  const [search, setSearch] = useState('');
  const [status, setStatus] = useState('');
  const [weave, setWeave] = useState('');
  const [page, setPage] = useState(0);

  const statuses = useMemo(
    () => [...new Set(products.map((p) => p.product_state).filter(Boolean))].sort() as string[],
    [products],
  );
  const weaves = useMemo(
    () => [...new Set(products.map((p) => p.weave_type).filter(Boolean))].sort() as string[],
    [products],
  );

  const filtered = products.filter(
    (p) =>
      (!status || p.product_state === status) &&
      (!weave || p.weave_type === weave) &&
      (!search ||
        [p.sku, p.product_code, p.product_name, p.product_variant, p.color].some((v) =>
          norm(v).includes(norm(search)),
        )),
  );

  const pageCount = Math.max(1, Math.ceil(filtered.length / PAGE));
  const p = Math.min(page, pageCount - 1);
  const pageRows = filtered.slice(p * PAGE, p * PAGE + PAGE);

  return (
    <>
      <Notice tone="info">
        SKU-level product master pulled from GCP and refreshed daily. Read-only — status
        and Woven/Knitted here feed the Buying Plan (rolled up to product code).
      </Notice>

      <div className="wf-toolbar">
        <div className="wf-toolbar-left">
          <label className="field">
            <span>Search</span>
            <input
              placeholder="SKU, code, name, variant or colour"
              value={search}
              onChange={(e) => { setSearch(e.target.value); setPage(0); }}
            />
          </label>
          <label className="field">
            <span>Status</span>
            <select value={status} onChange={(e) => { setStatus(e.target.value); setPage(0); }}>
              <option value="">All</option>
              {statuses.map((s) => <option key={s}>{s}</option>)}
            </select>
          </label>
          <label className="field">
            <span>Weave</span>
            <select value={weave} onChange={(e) => { setWeave(e.target.value); setPage(0); }}>
              <option value="">All</option>
              {weaves.map((w) => <option key={w}>{w}</option>)}
            </select>
          </label>
        </div>
        <div className="wf-chip">{fmt.format(filtered.length)} SKUs</div>
      </div>

      {!products.length && (
        <Notice tone="info">
          No rows yet. (Loads once the GCP product-master sync has run.)
        </Notice>
      )}

      <div className="table-panel wf-grid-panel">
        <div className="table-scroll">
          <table className="wf-grid">
            <thead>
              <tr>
                {COLS.map((c) => (
                  <th key={c.key} className={c.kind === 'num' ? 'num' : undefined}>{c.label}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {pageRows.map((row) => (
                <tr key={row.sku}>
                  {COLS.map((c) => (
                    <td key={c.key} className={c.kind === 'num' ? 'num' : c.kind === 'mono' ? 'mono' : undefined}>
                      {cell(row, c)}
                    </td>
                  ))}
                </tr>
              ))}
              {!filtered.length && products.length > 0 && (
                <tr>
                  <td colSpan={COLS.length} className="wf-empty-cell">No SKUs match your filters.</td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
        {pageCount > 1 && (
          <div className="pager">
            <button type="button" disabled={p <= 0} onClick={() => setPage(p - 1)}>Prev</button>
            <span>Page {p + 1} of {pageCount} · {fmt.format(filtered.length)} SKUs</span>
            <button type="button" disabled={p >= pageCount - 1} onClick={() => setPage(p + 1)}>Next</button>
          </div>
        )}
      </div>
    </>
  );
}
