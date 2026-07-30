'use client';

import { useMemo, useState } from 'react';
import { Notice } from '@/components/forms/form-layout';
import type { ReplenishmentRow } from '@/lib/forms/types';

const fmt = new Intl.NumberFormat('en-IN', { maximumFractionDigits: 0 });

export function ReplenishmentClient({ rows }: { rows: ReplenishmentRow[] }) {
  const [search, setSearch] = useState('');
  const [coverage, setCoverage] = useState<'rop_30' | 'rop_60' | 'rop_90'>('rop_30');

  const shown = useMemo(() => {
    const q = search.trim().toLowerCase();
    if (!q) return rows;
    return rows.filter((r) =>
      `${r.product_code ?? ''} ${r.product_variant} ${r.product_name ?? ''}`
        .toLowerCase()
        .includes(q),
    );
  }, [rows, search]);

  const totals = useMemo(
    () =>
      shown.reduce(
        (acc, r) => ({
          rop_30: acc.rop_30 + r.rop_30,
          rop_60: acc.rop_60 + r.rop_60,
          rop_90: acc.rop_90 + r.rop_90,
        }),
        { rop_30: 0, rop_60: 0, rop_90: 0 },
      ),
    [shown],
  );
  const oosCount = shown.filter((r) => r.oos_flag).length;

  return (
    <>
      <Notice tone="info">
        Reorder qty = <strong>daily demand × coverage days − current stock − in-process</strong>,
        per colour. 30 days is the immediate gap; 60/90 add forward coverage for
        long-lead (FOB) vendors. This feeds the Buying Plan's <strong>Pending
        Quantity</strong> (30-day by default).
      </Notice>

      <div className="metric-grid wf-metric-grid">
        <div className="metric-card">
          <span className="metric-label">30-day reorder</span>
          <strong>{fmt.format(totals.rop_30)}</strong>
        </div>
        <div className="metric-card">
          <span className="metric-label">60-day reorder</span>
          <strong>{fmt.format(totals.rop_60)}</strong>
        </div>
        <div className="metric-card">
          <span className="metric-label">90-day reorder</span>
          <strong>{fmt.format(totals.rop_90)}</strong>
        </div>
        <div className={oosCount ? 'metric-card tone-orange' : 'metric-card'}>
          <span className="metric-label">Out of stock</span>
          <strong>{oosCount}</strong>
        </div>
      </div>

      <div className="wf-toolbar">
        <input
          className="wf-search"
          placeholder="Filter product / colour…"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
        />
        <div className="segment wf-segment">
          {(['rop_30', 'rop_60', 'rop_90'] as const).map((c) => (
            <button
              key={c}
              type="button"
              className={coverage === c ? 'active' : ''}
              onClick={() => setCoverage(c)}
            >
              {c.replace('rop_', '')}d
            </button>
          ))}
        </div>
        <span className="wf-chip">{shown.length} colours to reorder</span>
      </div>

      <div className="table-panel wf-grid-panel">
        <div className="table-scroll">
          <table className="wide-table wf-grid">
            <thead>
              <tr>
                <th>Product / colour</th>
                <th>Status</th>
                <th className="num">Stock</th>
                <th className="num">In process</th>
                <th className="num">Daily demand</th>
                <th className="num">DOQ</th>
                <th>OOS</th>
                <th className={coverage === 'rop_30' ? 'num strong' : 'num'}>30d</th>
                <th className={coverage === 'rop_60' ? 'num strong' : 'num'}>60d</th>
                <th className={coverage === 'rop_90' ? 'num strong' : 'num'}>90d</th>
              </tr>
            </thead>
            <tbody>
              {shown.map((r) => (
                <tr key={r.product_variant} className={r.oos_flag ? 'wf-row-over' : ''}>
                  <td>
                    <span className="mono">{r.product_variant}</span>
                    <small className="wf-subtle">{r.product_name ?? r.product_code}</small>
                  </td>
                  <td className="wf-subtle">{r.product_state ?? '—'}</td>
                  <td className="num">{fmt.format(r.current_stock)}</td>
                  <td className="num">{fmt.format(r.in_progress)}</td>
                  <td className="num">{r.daily_demand}</td>
                  <td className="num">{r.doq_45 ?? '—'}</td>
                  <td>{r.oos_flag ? <span className="wf-over-tag">OOS</span> : ''}</td>
                  <td className={coverage === 'rop_30' ? 'num strong' : 'num'}>{fmt.format(r.rop_30)}</td>
                  <td className={coverage === 'rop_60' ? 'num strong' : 'num'}>{fmt.format(r.rop_60)}</td>
                  <td className={coverage === 'rop_90' ? 'num strong' : 'num'}>{fmt.format(r.rop_90)}</td>
                </tr>
              ))}
              {!shown.length && (
                <tr>
                  <td colSpan={10} className="wf-empty-cell">
                    Nothing needs reordering right now.
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
