'use client';

import { Fragment, useMemo, useState } from 'react';
import type { CostAnalyticsRow } from '@/lib/cost-analytics.server';

type Dim = 'vendor' | 'product' | 'category';
type Lens = 'std-actual' | 'efob';

const inr = new Intl.NumberFormat('en-IN', { maximumFractionDigits: 0 });
const num1 = (v: number | null) => (v == null ? '—' : v.toFixed(1));
const money = (v: number | null) => (v == null ? '—' : `₹${inr.format(Math.round(v))}`);
const pct = (v: number | null) => (v == null ? '—' : `${v > 0 ? '+' : ''}${v.toFixed(1)}%`);
const isEfob = (t: string | null) => (t ?? '').toLowerCase().includes('efob');
const isFob = (t: string | null) => {
  const s = (t ?? '').toLowerCase();
  return s.includes('fob') && !s.includes('efob');
};

type Group = {
  key: string;
  label: string;
  count: number;
  deltaValue: number; // sum of delta×qty across POs with a delta
  avgDelta: number | null; // per-unit, averaged
  avgDeltaPct: number | null;
  over: number;
  under: number;
  rows: CostAnalyticsRow[];
};

function groupBy(rows: CostAnalyticsRow[], dim: Dim): Group[] {
  const keyOf = (r: CostAnalyticsRow) =>
    dim === 'vendor'
      ? r.vendorCode || r.vendorName || '—'
      : dim === 'product'
        ? r.productCode || '—'
        : r.category || 'Uncategorised';
  const labelOf = (r: CostAnalyticsRow) =>
    dim === 'vendor' ? r.vendorName || r.vendorCode || '—' : keyOf(r);

  const map = new Map<string, Group>();
  for (const r of rows) {
    const k = keyOf(r);
    const g =
      map.get(k) ??
      { key: k, label: labelOf(r), count: 0, deltaValue: 0, avgDelta: null, avgDeltaPct: null, over: 0, under: 0, rows: [] as CostAnalyticsRow[] };
    g.count += 1;
    g.rows.push(r);
    if (r.delta != null) {
      g.deltaValue += r.deltaValue ?? 0;
      if (r.delta > 0.005) g.over += 1;
      else if (r.delta < -0.005) g.under += 1;
    }
    map.set(k, g);
  }
  for (const g of map.values()) {
    const withDelta = g.rows.filter((r) => r.delta != null);
    g.avgDelta = withDelta.length
      ? withDelta.reduce((s, r) => s + (r.delta ?? 0), 0) / withDelta.length
      : null;
    const withPct = g.rows.filter((r) => r.deltaPct != null);
    g.avgDeltaPct = withPct.length
      ? withPct.reduce((s, r) => s + (r.deltaPct ?? 0), 0) / withPct.length
      : null;
  }
  return [...map.values()].sort((a, b) => Math.abs(b.deltaValue) - Math.abs(a.deltaValue));
}

function tone(delta: number | null): string {
  if (delta == null) return '';
  if (delta > 0.005) return 'ca-over';
  if (delta < -0.005) return 'ca-under';
  return 'ca-flat';
}

export function CostAnalyticsClient({ rows }: { rows: CostAnalyticsRow[] }) {
  const [lens, setLens] = useState<Lens>('std-actual');

  return (
    <div className="ca-root">
      <div className="ca-lens-tabs">
        <button className={lens === 'std-actual' ? 'active' : ''} onClick={() => setLens('std-actual')}>
          Standard vs Actual
        </button>
        <button className={lens === 'efob' ? 'active' : ''} onClick={() => setLens('efob')}>
          EFOB
        </button>
      </div>

      {!rows.length && (
        <p className="wf-subtle ca-empty">
          No priced POs yet — this lights up once POs carry a rate and products have an approved
          standard cost. The view and its slices are ready; only the data is pending.
        </p>
      )}

      {lens === 'std-actual' ? <StdActualLens rows={rows} /> : <EfobLens rows={rows} />}
    </div>
  );
}

function StdActualLens({ rows }: { rows: CostAnalyticsRow[] }) {
  const [dim, setDim] = useState<Dim>('vendor');
  const groups = useMemo(() => groupBy(rows, dim), [rows, dim]);
  const [openKey, setOpenKey] = useState<string | null>(null);

  return (
    <>
      <div className="ca-dim-tabs">
        <span className="wf-subtle">Break down by</span>
        {(['vendor', 'product', 'category'] as const).map((d) => (
          <button key={d} className={dim === d ? 'active' : ''} onClick={() => { setDim(d); setOpenKey(null); }}>
            {d[0].toUpperCase() + d.slice(1)}
          </button>
        ))}
      </div>
      <div className="table-panel wf-grid-panel">
        <div className="table-scroll">
          <table className="wf-grid">
            <thead>
              <tr>
                <th>{dim[0].toUpperCase() + dim.slice(1)}</th>
                <th className="num">POs</th>
                <th className="num">Avg Δ / unit</th>
                <th className="num">Avg Δ %</th>
                <th className="num">Total Δ value</th>
                <th>Tendency</th>
              </tr>
            </thead>
            <tbody>
              {groups.map((g) => (
                <Fragment key={g.key}>
                  <tr className="ca-group-row" onClick={() => setOpenKey(openKey === g.key ? null : g.key)}>
                    <td><strong>{g.label}</strong></td>
                    <td className="num">{g.count}</td>
                    <td className={`num ${tone(g.avgDelta)}`}>{num1(g.avgDelta)}</td>
                    <td className={`num ${tone(g.avgDelta)}`}>{pct(g.avgDeltaPct)}</td>
                    <td className={`num ${tone(g.deltaValue)}`}>{money(g.deltaValue)}</td>
                    <td>
                      {g.over + g.under === 0 ? (
                        <span className="wf-subtle">—</span>
                      ) : (
                        <span className="ca-tendency">
                          {g.over >= g.under ? `${g.over}/${g.over + g.under} over` : `${g.under}/${g.over + g.under} under`}
                        </span>
                      )}
                    </td>
                  </tr>
                  {openKey === g.key && (
                    <tr className="ca-drill-row">
                      <td colSpan={6}>
                        <PoLevelTable rows={g.rows} />
                      </td>
                    </tr>
                  )}
                </Fragment>
              ))}
              {!groups.length && (
                <tr><td colSpan={6} className="wf-empty-cell">Nothing to break down yet.</td></tr>
              )}
            </tbody>
          </table>
        </div>
      </div>
    </>
  );
}

function PoLevelTable({ rows }: { rows: CostAnalyticsRow[] }) {
  return (
    <table className="wf-grid ca-po-table">
      <thead>
        <tr>
          <th>PO</th>
          <th>Product</th>
          <th>Vendor</th>
          <th>Type</th>
          <th className="num">Qty</th>
          <th className="num">Standard</th>
          <th className="num">Expected</th>
          <th className="num">Actual</th>
          <th className="num">Δ / unit</th>
          <th className="num">Δ value</th>
        </tr>
      </thead>
      <tbody>
        {rows.map((r, i) => (
          <tr key={`${r.poRef ?? 'po'}-${i}`}>
            <td>{r.poRef ?? '—'}</td>
            <td>{r.productCode ?? '—'}</td>
            <td>{r.vendorName ?? r.vendorCode ?? '—'}</td>
            <td>{(r.poType ?? '—').toUpperCase()}</td>
            <td className="num">{r.qty ? inr.format(r.qty) : '—'}</td>
            <td className="num">{num1(r.standard)}</td>
            <td className="num">{num1(r.expected)}</td>
            <td className="num">{num1(r.actual)}</td>
            <td className={`num ${tone(r.delta)}`}>{num1(r.delta)}</td>
            <td className={`num ${tone(r.delta)}`}>{money(r.deltaValue)}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

function EfobLens({ rows }: { rows: CostAnalyticsRow[] }) {
  const efob = rows.filter((r) => isEfob(r.poType));
  const fob = rows.filter((r) => isFob(r.poType));
  const [dim, setDim] = useState<Dim>('product');
  const groups = useMemo(() => groupBy(efob, dim), [efob, dim]);
  const [openKey, setOpenKey] = useState<string | null>(null);

  const val = (rs: CostAnalyticsRow[]) =>
    rs.reduce((s, r) => s + (r.actual != null ? r.actual * r.qty : 0), 0);
  const totalValue = val(rows);
  const efobValue = val(efob);
  const efobShare = totalValue > 0 ? (efobValue / totalValue) * 100 : null;
  const avgDeltaPct = (rs: CostAnalyticsRow[]) => {
    const w = rs.filter((r) => r.deltaPct != null);
    return w.length ? w.reduce((s, r) => s + (r.deltaPct ?? 0), 0) / w.length : null;
  };

  return (
    <>
      <div className="ca-kpi-row">
        <div className="ca-kpi">
          <span className="ca-kpi-label">EFOB POs</span>
          <strong>{efob.length}</strong>
          <small>of {rows.length} total</small>
        </div>
        <div className="ca-kpi">
          <span className="ca-kpi-label">EFOB value</span>
          <strong>{money(efobValue)}</strong>
          <small>{efobShare == null ? '—' : `${efobShare.toFixed(0)}% of all PO value`}</small>
        </div>
        <div className="ca-kpi">
          <span className="ca-kpi-label">EFOB avg Δ%</span>
          <strong className={tone(avgDeltaPct(efob))}>{pct(avgDeltaPct(efob))}</strong>
          <small>vs FOB {pct(avgDeltaPct(fob))}</small>
        </div>
      </div>

      <p className="wf-subtle">
        EFOB overpay / underpay against the expected cost, by {dim}. EFOB carries the commodity
        risk on the vendor&rsquo;s behalf, so its deltas are read separately from FOB.
      </p>
      <div className="ca-dim-tabs">
        <span className="wf-subtle">Break down by</span>
        {(['product', 'vendor', 'category'] as const).map((d) => (
          <button key={d} className={dim === d ? 'active' : ''} onClick={() => { setDim(d); setOpenKey(null); }}>
            {d[0].toUpperCase() + d.slice(1)}
          </button>
        ))}
      </div>
      <div className="table-panel wf-grid-panel">
        <div className="table-scroll">
          <table className="wf-grid">
            <thead>
              <tr>
                <th>{dim[0].toUpperCase() + dim.slice(1)}</th>
                <th className="num">EFOB POs</th>
                <th className="num">Avg Δ / unit</th>
                <th className="num">Avg Δ %</th>
                <th className="num">Total Δ value</th>
              </tr>
            </thead>
            <tbody>
              {groups.map((g) => (
                <Fragment key={g.key}>
                  <tr className="ca-group-row" onClick={() => setOpenKey(openKey === g.key ? null : g.key)}>
                    <td><strong>{g.label}</strong></td>
                    <td className="num">{g.count}</td>
                    <td className={`num ${tone(g.avgDelta)}`}>{num1(g.avgDelta)}</td>
                    <td className={`num ${tone(g.avgDelta)}`}>{pct(g.avgDeltaPct)}</td>
                    <td className={`num ${tone(g.deltaValue)}`}>{money(g.deltaValue)}</td>
                  </tr>
                  {openKey === g.key && (
                    <tr className="ca-drill-row">
                      <td colSpan={5}><PoLevelTable rows={g.rows} /></td>
                    </tr>
                  )}
                </Fragment>
              ))}
              {!groups.length && (
                <tr><td colSpan={5} className="wf-empty-cell">No EFOB POs yet.</td></tr>
              )}
            </tbody>
          </table>
        </div>
      </div>
    </>
  );
}
