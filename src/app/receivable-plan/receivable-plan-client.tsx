'use client';

import { useMemo, useState, useTransition } from 'react';
import { Save } from 'lucide-react';
import { saveReceivableInput, submitReceivablePlan } from '@/lib/forms/actions';
import { Notice } from '@/components/forms/form-layout';
import type { ReceivablePlanRow } from '@/lib/forms/types';

const fmt = new Intl.NumberFormat('en-IN', { maximumFractionDigits: 0 });
const SIZE_KEYS = [
  ['size_xs', 'XS'], ['size_s', 'S'], ['size_m', 'M'], ['size_l', 'L'],
  ['size_xl', 'XL'], ['size_2xl', '2XL'], ['size_3xl', '3XL'],
  ['size_4xl', '4XL'], ['size_5xl', '5XL'],
] as const;
const cell = (v: number | null) => (v ? fmt.format(v) : '');
const statusTone = (s: string | null) =>
  s === 'Overdue' ? 'danger' : s === 'High Risk' ? 'warn' : 'success';

export function ReceivablePlanClient({
  rows,
  editable,
  weekStart,
  weekEnd,
}: {
  rows: ReceivablePlanRow[];
  editable: boolean;
  weekStart: string;
  weekEnd: string;
}) {
  const [search, setSearch] = useState('');
  const [vendor, setVendor] = useState('');
  const [state, setState] = useState('');
  const [oosOnly, setOosOnly] = useState(false);
  const [risk, setRisk] = useState('');
  const [edd, setEdd] = useState<'all' | 'has' | 'week'>('all');
  const [message, setMessage] = useState<string | null>(null);
  const [submitting, startSubmit] = useTransition();

  function submitAll() {
    startSubmit(async () => {
      const res = await submitReceivablePlan();
      setMessage(res.ok ? res.message ?? 'Submitted.' : res.error);
    });
  }

  const vendors = useMemo(
    () => [...new Set(rows.map((r) => r.vendor_name).filter(Boolean))].sort() as string[],
    [rows],
  );
  const states = useMemo(
    () => [...new Set(rows.map((r) => r.product_state).filter(Boolean))].sort() as string[],
    [rows],
  );

  const shown = useMemo(() => {
    const q = search.trim().toLowerCase();
    return rows.filter((r) => {
      if (q &&
        !`${r.po_number} ${r.po_ref_num ?? ''} ${r.product_code ?? ''} ${r.product_variant} ${r.vendor_name ?? ''}`
          .toLowerCase()
          .includes(q)
      ) return false;
      if (vendor && r.vendor_name !== vendor) return false;
      if (state && r.product_state !== state) return false;
      if (risk && r.internal_status !== risk) return false;
      if (oosOnly && !r.oos_flag) return false;
      if (edd === 'has' && !r.expected_delivery_date) return false;
      if (edd === 'week') {
        const d = r.expected_delivery_date;
        if (!d || d < weekStart || d > weekEnd) return false;
      }
      return true;
    });
  }, [rows, search, vendor, state, risk, oosOnly, edd, weekStart, weekEnd]);

  const oosCount = rows.filter((r) => r.oos_flag).length;

  // Most-recent weekly-input save across all rows — the "last updated" stamp.
  const lastUpdated = useMemo(() => {
    const stamps = rows.map((r) => r.input_updated_at).filter(Boolean) as string[];
    return stamps.length ? stamps.sort().at(-1)!.slice(0, 10) : null;
  }, [rows]);

  return (
    <>
      <Notice tone="info">
        Each row is one colour on an open PO, split by size — each size cell shows{' '}
        <strong>arriving</strong> (top) over <strong>in stock</strong> (below, muted). DOQ,
        stock and OOS come from the inventory-planning snapshot. <strong>Status</strong> is the
        live TNA risk — <em>Overdue</em> (EDD passed), <em>High Risk</em> (a critical-path stage
        past its planned date with no actual), or <em>On Track</em> — with the ERP status beneath.
        Fill{' '}
        <strong>delivery date</strong> and <strong>qty expected this week</strong> — the only
        two editable fields — for the receiving plan.
        {lastUpdated && (
          <> Weekly plan last updated <strong>{lastUpdated}</strong>.</>
        )}
      </Notice>

      {message && <Notice tone="ok">{message}</Notice>}

      <div className="wf-toolbar wf-filter-bar">
        <input
          className="wf-search"
          placeholder="Filter PO / product / vendor…"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
        />
        <select value={vendor} onChange={(e) => setVendor(e.target.value)} aria-label="Vendor">
          <option value="">All vendors</option>
          {vendors.map((v) => (
            <option key={v} value={v}>{v}</option>
          ))}
        </select>
        <select value={state} onChange={(e) => setState(e.target.value)} aria-label="Product state">
          <option value="">All states</option>
          {states.map((s) => (
            <option key={s} value={s}>{s}</option>
          ))}
        </select>
        <select value={risk} onChange={(e) => setRisk(e.target.value)} aria-label="TNA risk status">
          <option value="">All statuses</option>
          <option value="Overdue">Overdue</option>
          <option value="High Risk">High Risk</option>
          <option value="On Track">On Track</option>
        </select>
        <select value={edd} onChange={(e) => setEdd(e.target.value as 'all' | 'has' | 'week')} aria-label="Delivery">
          <option value="all">Any delivery</option>
          <option value="has">Has EDD</option>
          <option value="week">Arriving this week</option>
        </select>
        <label className="wf-check">
          <input type="checkbox" checked={oosOnly} onChange={(e) => setOosOnly(e.target.checked)} />
          OOS only
        </label>
        <span className="wf-chip">
          {shown.length} rows
          {oosCount > 0 && <em className="wf-chip-warn">{oosCount} OOS</em>}
        </span>
        {editable && (
          <button
            type="button"
            className="wf-btn wf-btn-primary wf-btn-sm"
            disabled={submitting}
            onClick={submitAll}
          >
            {submitting ? 'Submitting…' : 'Submit week for approval'}
          </button>
        )}
      </div>

      <div className="table-panel wf-grid-panel">
        <div className="table-scroll">
          <table className="wide-table wf-grid">
            <thead>
              <tr>
                <th>PO</th>
                <th>Product / colour</th>
                <th>Vendor</th>
                <th>Status</th>
                <th className="num">Arriving</th>
                {SIZE_KEYS.map(([, label]) => (
                  <th key={label} className="num">{label}</th>
                ))}
                <th className="num">DOQ</th>
                <th className="num">Stock</th>
                <th className="num">Sizes in stock</th>
                <th>OOS</th>
                <th className="num">EDD</th>
                <th className="num input-col">Deliver this wk</th>
                <th className="num input-col">Qty this wk</th>
                {editable && <th aria-label="Save" />}
              </tr>
            </thead>
            <tbody>
              {shown.map((row) => (
                <ReceivableRow
                  key={row.row_key}
                  row={row}
                  editable={editable}
                  onSaved={() => setMessage('Saved.')}
                />
              ))}
              {!shown.length && (
                <tr>
                  <td colSpan={editable ? 22 : 21} className="wf-empty-cell">
                    No open receivables match.
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </div>
    </>
  );
}

function ReceivableRow({
  row,
  editable,
  onSaved,
}: {
  row: ReceivablePlanRow;
  editable: boolean;
  onSaved: () => void;
}) {
  const [deliver, setDeliver] = useState(row.delivery_date_this_week ?? '');
  const [qty, setQty] = useState(row.qty_expected_this_week?.toString() ?? '');
  const [pending, start] = useTransition();

  const dirty =
    deliver !== (row.delivery_date_this_week ?? '') ||
    qty !== (row.qty_expected_this_week?.toString() ?? '');

  // % of the arriving qty covered by what's planned to land this week.
  const arriving = row.arriving_qty || 0;
  const qtyNum = Number(qty) || 0;
  const pctComplete = arriving > 0 ? Math.round((qtyNum / arriving) * 100) : null;

  // Sizes in stock now vs. total sizes on this arriving line (SKU-level, so the
  // aggregate OOS count is broken down to "which sizes are actually covered").
  const totalSizes = SIZE_KEYS.filter(([k]) => row[k]).length;
  const inStockSizes = SIZE_KEYS.filter(([k]) => (row.stock_by_size?.[k] ?? 0) > 0).length;

  function save() {
    const fd = new FormData();
    fd.set('row_key', row.row_key);
    fd.set('delivery_date_this_week', deliver);
    fd.set('qty_expected_this_week', qty);
    start(async () => {
      const res = await saveReceivableInput(fd);
      if (res.ok) onSaved();
    });
  }

  return (
    <tr className={row.oos_flag ? 'wf-row-over' : ''}>
      <td className="mono wf-po-primary">
        <strong>{row.po_number}</strong>
        <small className="wf-subtle">{row.po_ref_num}</small>
      </td>
      <td>
        <span className="mono">{row.product_variant}</span>
        <small className="wf-subtle">{row.product_state ?? row.product_code}</small>
      </td>
      <td>{row.vendor_name || row.vendor_code || '—'}</td>
      <td>
        {row.internal_status ? (
          <span className={`badge ${statusTone(row.internal_status)}`}>
            {row.internal_status}
          </span>
        ) : '—'}
        {row.po_status && <small className="wf-subtle">{row.po_status}</small>}
      </td>
      <td className="num strong">{fmt.format(row.arriving_qty)}</td>
      {SIZE_KEYS.map(([key]) => {
        const stock = row.stock_by_size?.[key];
        return (
          <td key={key} className="num wf-size-cell">
            <span className="wf-size-arr">{cell(row[key])}</span>
            <small className="wf-size-stk">{stock ? fmt.format(stock) : ''}</small>
          </td>
        );
      })}
      <td className="num">{row.doq_45 != null ? row.doq_45 : '—'}</td>
      <td className="num">{row.current_stock != null ? fmt.format(row.current_stock) : '—'}</td>
      <td className="num">
        {totalSizes ? (
          <span className={inStockSizes < totalSizes ? 'wf-over-tag' : ''}>
            {inStockSizes}/{totalSizes}
          </span>
        ) : '—'}
      </td>
      <td>{row.oos_flag ? <span className="wf-over-tag">OOS</span> : ''}</td>
      <td className="num wf-subtle">{row.expected_delivery_date ?? '—'}</td>
      <td className="num input-col">
        <input
          type="date"
          value={deliver}
          disabled={!editable}
          onChange={(e) => setDeliver(e.target.value)}
        />
      </td>
      <td className="num input-col">
        <input
          type="number"
          min={0}
          value={qty}
          disabled={!editable}
          onChange={(e) => setQty(e.target.value)}
        />
        <small className="wf-subtle wf-qty-meta">
          {pctComplete != null && <span>{pctComplete}% of arriving</span>}
          {row.input_updated_at && (
            <span>updated {row.input_updated_at.slice(0, 10)}</span>
          )}
        </small>
      </td>
      {editable && (
        <td>
          <button
            type="button"
            className="wf-btn wf-btn-ghost wf-btn-sm"
            disabled={!dirty || pending}
            onClick={save}
          >
            <Save size={13} /> Save
          </button>
        </td>
      )}
    </tr>
  );
}
