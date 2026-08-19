'use client';

import { useMemo, useState } from 'react';
import { Notice } from '@/components/forms/form-layout';
import type { OosCalculationRow } from '@/lib/forms/types';

const fmt = new Intl.NumberFormat('en-IN', { maximumFractionDigits: 2 });
const PAGE = 50;
const norm = (v: string | null) => (v ?? '').trim().toLowerCase();

type Col = { key: keyof OosCalculationRow; label: string; kind: 'text' | 'mono' | 'num' };

// The full sheet, column-for-column (kept in the sheet's order).
const COLS: Col[] = [
  { key: 'sku', label: 'SKU', kind: 'mono' },
  { key: 'product_status', label: 'Product Status', kind: 'text' },
  { key: 'category_with_gender', label: 'Category w/ Gender', kind: 'text' },
  { key: 'rm_code', label: 'RM Code', kind: 'mono' },
  { key: 'dyed_fabric_sku', label: 'Dyed Fabric SKU', kind: 'mono' },
  { key: 'product_variant', label: 'Product Variant', kind: 'mono' },
  { key: 'product_code', label: 'Product Code', kind: 'mono' },
  { key: 'product_name', label: 'Product Name', kind: 'text' },
  { key: 'color', label: 'Colour', kind: 'text' },
  { key: 'size', label: 'Size', kind: 'text' },
  { key: 'new_size', label: 'New Size', kind: 'text' },
  { key: 'total_inventory_days', label: 'Total Inventory Days', kind: 'num' },
  { key: 'total_oos_days', label: 'Total OOS Days', kind: 'num' },
  { key: 'total_available_days', label: 'Total Available Days', kind: 'num' },
  { key: 'total_qty_sold', label: 'Total Qty Sold', kind: 'num' },
  { key: 'doq_45', label: '45 Days DOQ', kind: 'num' },
  { key: 'launch_date', label: 'Launch Date', kind: 'text' },
  { key: 'product_class', label: 'Product Class', kind: 'text' },
  { key: 'current_stock', label: 'Current Stock', kind: 'num' },
  { key: 'doh', label: 'DOH', kind: 'num' },
  { key: 'sales_value', label: 'Sales Value', kind: 'num' },
  { key: 'sales_leakage', label: 'Sales Leakage', kind: 'num' },
  { key: 'inprocess_stock', label: 'Inprocess Stock', kind: 'num' },
  { key: 'doh_with_inprocess', label: 'DOH (+ Inprocess)', kind: 'num' },
  { key: 'cancelled', label: 'Cancelled', kind: 'num' },
  { key: 'returned', label: 'Returned', kind: 'num' },
  { key: 'com_status', label: 'COM Status', kind: 'text' },
  { key: 'weave_type', label: 'Weave Type', kind: 'text' },
  { key: 'unique_key', label: 'Unique', kind: 'text' },
];

function cell(row: OosCalculationRow, col: Col) {
  const v = row[col.key];
  if (v === null || v === undefined || v === '') return <span className="wf-subtle">—</span>;
  if (col.kind === 'num') return fmt.format(Number(v));
  return String(v);
}

export function OosCalculationClient({ rows }: { rows: OosCalculationRow[] }) {
  const [search, setSearch] = useState('');
  const [status, setStatus] = useState('');
  const [weave, setWeave] = useState('');
  const [page, setPage] = useState(0);

  const statuses = useMemo(
    () => [...new Set(rows.map((r) => r.product_status).filter(Boolean))].sort() as string[],
    [rows],
  );
  const weaves = useMemo(
    () => [...new Set(rows.map((r) => r.weave_type).filter(Boolean))].sort() as string[],
    [rows],
  );

  const filtered = rows.filter(
    (r) =>
      (!status || r.product_status === status) &&
      (!weave || r.weave_type === weave) &&
      (!search ||
        [r.sku, r.product_name, r.product_variant, r.rm_code, r.color].some((v) =>
          norm(v).includes(norm(search)),
        )),
  );

  const pageCount = Math.max(1, Math.ceil(filtered.length / PAGE));
  const p = Math.min(page, pageCount - 1);
  const pageRows = filtered.slice(p * PAGE, p * PAGE + PAGE);

  return (
    <>
      <div className="wf-toolbar">
        <div className="wf-toolbar-left">
          <label className="field">
            <span>Search</span>
            <input
              placeholder="SKU, name, variant, RM or colour"
              value={search}
              onChange={(e) => {
                setSearch(e.target.value);
                setPage(0);
              }}
            />
          </label>
          <label className="field">
            <span>Status</span>
            <select value={status} onChange={(e) => { setStatus(e.target.value); setPage(0); }}>
              <option value="">All</option>
              {statuses.map((s) => (
                <option key={s}>{s}</option>
              ))}
            </select>
          </label>
          <label className="field">
            <span>Weave</span>
            <select value={weave} onChange={(e) => { setWeave(e.target.value); setPage(0); }}>
              <option value="">All</option>
              {weaves.map((w) => (
                <option key={w}>{w}</option>
              ))}
            </select>
          </label>
        </div>
        <div className="wf-chip">{fmt.format(filtered.length)} SKUs</div>
      </div>

      {!rows.length && (
        <Notice tone="info">
          No rows yet. (Loads once the OOS backfill has run against saadaa_inventory_planning.)
        </Notice>
      )}

      <div className="table-panel wf-grid-panel">
        <div className="table-scroll">
          <table className="wf-grid">
            <thead>
              <tr>
                {COLS.map((c) => (
                  <th key={c.key} className={c.kind === 'num' ? 'num' : undefined}>
                    {c.label}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {pageRows.map((r) => (
                <tr key={r.sku}>
                  {COLS.map((c) => (
                    <td key={c.key} className={c.kind === 'num' ? 'num' : c.kind === 'mono' ? 'mono' : undefined}>
                      {cell(r, c)}
                    </td>
                  ))}
                </tr>
              ))}
              {!filtered.length && rows.length > 0 && (
                <tr>
                  <td colSpan={COLS.length} className="wf-empty-cell">
                    No SKUs match your filters.
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
        {pageCount > 1 && (
          <div className="pager">
            <button type="button" disabled={p <= 0} onClick={() => setPage(p - 1)}>
              Prev
            </button>
            <span>
              Page {p + 1} of {pageCount} · {fmt.format(filtered.length)} SKUs
            </span>
            <button type="button" disabled={p >= pageCount - 1} onClick={() => setPage(p + 1)}>
              Next
            </button>
          </div>
        )}
      </div>
    </>
  );
}
