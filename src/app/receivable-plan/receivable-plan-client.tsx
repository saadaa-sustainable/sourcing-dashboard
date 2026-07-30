'use client';

import { useMemo, useState, useTransition } from 'react';
import { Save } from 'lucide-react';
import { saveReceivableInput } from '@/lib/forms/actions';
import { Notice } from '@/components/forms/form-layout';
import type { ReceivablePlanRow } from '@/lib/forms/types';

const fmt = new Intl.NumberFormat('en-IN', { maximumFractionDigits: 0 });
const SIZE_KEYS = [
  ['size_xs', 'XS'], ['size_s', 'S'], ['size_m', 'M'], ['size_l', 'L'],
  ['size_xl', 'XL'], ['size_2xl', '2XL'], ['size_3xl', '3XL'],
  ['size_4xl', '4XL'], ['size_5xl', '5XL'],
] as const;
const cell = (v: number | null) => (v ? fmt.format(v) : '');

export function ReceivablePlanClient({
  rows,
  editable,
}: {
  rows: ReceivablePlanRow[];
  editable: boolean;
}) {
  const [search, setSearch] = useState('');
  const [message, setMessage] = useState<string | null>(null);

  const shown = useMemo(() => {
    const q = search.trim().toLowerCase();
    if (!q) return rows;
    return rows.filter((r) =>
      `${r.po_number} ${r.po_ref_num ?? ''} ${r.product_code ?? ''} ${r.product_variant} ${r.vendor_name ?? ''}`
        .toLowerCase()
        .includes(q),
    );
  }, [rows, search]);

  const oosCount = rows.filter((r) => r.oos_flag).length;

  return (
    <>
      <Notice tone="info">
        Each row is one colour on an open PO, split by size. DOQ, stock and OOS come
        from the inventory-planning snapshot. Fill <strong>delivery date</strong> and{' '}
        <strong>qty expected this week</strong> for the receiving plan.
      </Notice>

      {message && <Notice tone="ok">{message}</Notice>}

      <div className="wf-toolbar">
        <input
          className="wf-search"
          placeholder="Filter PO / product / vendor…"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
        />
        <span className="wf-chip">
          {shown.length} rows
          {oosCount > 0 && <em className="wf-chip-warn">{oosCount} OOS</em>}
        </span>
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
                <th>OOS</th>
                <th className="num">EDD</th>
                <th className="num input-col">Deliver this wk</th>
                <th className="num input-col">Qty this wk</th>
                <th>Remarks</th>
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
                  <td colSpan={22} className="wf-empty-cell">
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
  const [remarks, setRemarks] = useState(row.remarks ?? '');
  const [pending, start] = useTransition();

  const dirty =
    deliver !== (row.delivery_date_this_week ?? '') ||
    qty !== (row.qty_expected_this_week?.toString() ?? '') ||
    remarks !== (row.remarks ?? '');

  function save() {
    const fd = new FormData();
    fd.set('row_key', row.row_key);
    fd.set('delivery_date_this_week', deliver);
    fd.set('qty_expected_this_week', qty);
    fd.set('remarks', remarks);
    start(async () => {
      const res = await saveReceivableInput(fd);
      if (res.ok) onSaved();
    });
  }

  return (
    <tr className={row.oos_flag ? 'wf-row-over' : ''}>
      <td className="mono">
        {row.po_number}
        <small className="wf-subtle">{row.po_ref_num}</small>
      </td>
      <td>
        <span className="mono">{row.product_variant}</span>
        <small className="wf-subtle">{row.product_state ?? row.product_code}</small>
      </td>
      <td>{row.vendor_name || row.vendor_code || '—'}</td>
      <td className="wf-subtle">{row.po_status ?? '—'}</td>
      <td className="num strong">{fmt.format(row.arriving_qty)}</td>
      {SIZE_KEYS.map(([key]) => (
        <td key={key} className="num">{cell(row[key])}</td>
      ))}
      <td className="num">{row.doq_45 != null ? row.doq_45 : '—'}</td>
      <td className="num">{row.current_stock != null ? fmt.format(row.current_stock) : '—'}</td>
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
      </td>
      <td>
        <input
          value={remarks}
          disabled={!editable}
          placeholder="—"
          onChange={(e) => setRemarks(e.target.value)}
        />
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
