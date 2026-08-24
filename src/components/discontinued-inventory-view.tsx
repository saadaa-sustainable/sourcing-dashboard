'use client';

import { useMemo, useState } from 'react';
import {
  Bar,
  BarChart,
  CartesianGrid,
  Cell,
  LabelList,
  Legend,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts';
import { Download } from 'lucide-react';
import { Notice } from '@/components/forms/form-layout';
import { downloadCsv } from '@/lib/download';
import {
  AGEING_BUCKETS,
  RECOMMENDED_ACTIONS,
  rollupBySku,
  type AgeingBucket,
  type DiscontinuedInventoryRow,
  type RecommendedAction,
} from '@/lib/discontinued';

const fmt = new Intl.NumberFormat('en-IN', { maximumFractionDigits: 0 });
const money = new Intl.NumberFormat('en-IN', {
  style: 'currency',
  currency: 'INR',
  maximumFractionDigits: 0,
});

// New → Dead Stock, cool → hot.
const BUCKET_COLOR: Record<AgeingBucket, string> = {
  New: '#4f7c4d',
  Aging: '#f0c61e',
  Old: '#b57514',
  'Dead Stock': '#c0392b',
};

// Routine → urgent. Coloured outline badges (the .wf-status base is a
// currentColor-bordered pill, so the text colour tints the whole badge).
const ACTION_COLOR: Record<RecommendedAction, string> = {
  'Sell through naturally': '#4f7c4d',
  'Transfer to high-selling store': '#3b6fd4',
  'Run discount campaign': '#7b4fbf',
  'Bulk liquidation / B2B sale': '#b57514',
  'Write-off review': '#c0392b',
};

const uniq = (values: (string | null)[]) =>
  [...new Set(values.map((v) => (v ?? '').trim()).filter(Boolean))].sort();

// Dropdown option meaning “value is blank”.
const BLANK = '—';

export function DiscontinuedInventoryView({
  rows,
  salesByVariant,
}: {
  rows: DiscontinuedInventoryRow[];
  salesByVariant: Record<string, number>;
}) {
  const rollups = useMemo(
    () => rollupBySku(rows, new Map(Object.entries(salesByVariant))),
    [rows, salesByVariant],
  );

  const [search, setSearch] = useState('');
  const [category, setCategory] = useState('');
  const [color, setColor] = useState('');
  const [bucket, setBucket] = useState('');
  const [action, setAction] = useState('');

  const categories = useMemo(() => uniq(rollups.map((r) => r.category)), [rollups]);
  const colors = useMemo(() => uniq(rollups.map((r) => r.color)), [rollups]);

  const shown = useMemo(() => {
    const q = search.trim().toLowerCase();
    return rollups.filter(
      (r) =>
        (!category || (category === BLANK ? !r.category : r.category === category)) &&
        (!color || (color === BLANK ? !r.color : r.color === color)) &&
        (!bucket || r.bucket === bucket) &&
        (!action || r.action === action) &&
        (!q ||
          `${r.sku} ${r.productName ?? ''} ${r.color ?? ''} ${r.size ?? ''}`
            .toLowerCase()
            .includes(q)),
    );
  }, [rollups, search, category, color, bucket, action]);

  const kpis = useMemo(() => {
    const units = shown.reduce((s, r) => s + r.qty, 0);
    // Dead-stock is counted at UNIT level (each unit by its own age), so a SKU's
    // newer units are not swept in just because its oldest unit is aged.
    const deadUnits = shown.reduce((s, r) => s + r.unitsByBucket['Dead Stock'], 0);
    return {
      units,
      skus: shown.length,
      deadUnits,
      deadPct: units ? Math.round((deadUnits / units) * 100) : 0,
      valueCost: shown.reduce((s, r) => s + r.valueAtCost, 0),
      valueMrp: shown.reduce((s, r) => s + r.valueAtMrp, 0),
    };
  }, [shown]);

  const ageingChart = useMemo(
    () =>
      AGEING_BUCKETS.map((b) => ({
        name: b,
        units: shown.reduce((s, r) => s + r.unitsByBucket[b], 0),
      })),
    [shown],
  );

  const actionCounts = useMemo(
    () =>
      RECOMMENDED_ACTIONS.map((a) => ({
        action: a,
        count: shown.filter((r) => r.action === a).length,
      })).filter((a) => a.count),
    [shown],
  );

  // Product-category × ageing-bucket × available units (unit-level), most first.
  const categoryChart = useMemo(() => {
    const byCat = new Map<string, Record<AgeingBucket, number>>();
    for (const r of shown) {
      const cat = (r.category ?? '').trim() || '—';
      const acc = byCat.get(cat) ?? { New: 0, Aging: 0, Old: 0, 'Dead Stock': 0 };
      for (const b of AGEING_BUCKETS) acc[b] += r.unitsByBucket[b];
      byCat.set(cat, acc);
    }
    return [...byCat.entries()]
      .map(([category, b]) => ({ category, ...b, total: AGEING_BUCKETS.reduce((s, k) => s + b[k], 0) }))
      .sort((a, b) => b.total - a.total);
  }, [shown]);

  function exportCsv() {
    downloadCsv(
      'discontinued-inventory',
      [
        'SKU',
        'Product',
        'Colour',
        'Size',
        'Available qty',
        'Oldest days',
        'Ageing bucket',
        'Recommended discount',
        'Recommended action',
        'Value at cost',
        'Value at MRP',
      ],
      shown.map((r) => [
        r.sku,
        r.productName,
        r.color,
        r.size,
        r.qty,
        r.oldestDays,
        r.bucket,
        r.suggestedDiscount,
        r.action,
        Math.round(r.valueAtCost),
        Math.round(r.valueAtMrp),
      ]),
    );
  }

  return (
    <>
      <h2 style={{ margin: '0 0 12px' }}>Discontinued Products View</h2>
      <Notice tone="info">
        Discontinued-product stock, aged by <strong>days in warehouse</strong> (from
        the sheet). Qty is counted <strong>per SKU (colour + size)</strong>; a SKU&apos;s
        ageing uses its oldest available unit. Suggested discount and recommended
        action follow the ops rules (New &lt;90d · Aging 90–180 · Old 180–365 · Dead
        Stock &gt;365).
      </Notice>

      <div className="metric-grid wf-metric-grid">
        <div className="metric-card">
          <span className="metric-label">Available units</span>
          <strong>{fmt.format(kpis.units)}</strong>
        </div>
        <div className="metric-card">
          <span className="metric-label">SKUs with stock</span>
          <strong>{fmt.format(kpis.skus)}</strong>
        </div>
        <div className={kpis.deadUnits ? 'metric-card tone-red' : 'metric-card'}>
          <span className="metric-label">Dead-stock units</span>
          <strong>{fmt.format(kpis.deadUnits)}</strong>
          <small>{kpis.deadPct}% of units</small>
        </div>
        <div className="metric-card">
          <span className="metric-label">Value at cost</span>
          <strong>{money.format(kpis.valueCost)}</strong>
        </div>
        <div className="metric-card">
          <span className="metric-label">Value at MRP</span>
          <strong>{money.format(kpis.valueMrp)}</strong>
        </div>
      </div>

      <div className="table-panel wf-grid-panel" style={{ padding: '14px 16px' }}>
        <div style={{ height: 240 }}>
          <ResponsiveContainer>
            <BarChart data={ageingChart} margin={{ top: 16, right: 12, left: -8, bottom: 4 }}>
              <CartesianGrid strokeDasharray="3 3" vertical={false} />
              <XAxis dataKey="name" />
              <YAxis />
              <Tooltip formatter={(v) => [fmt.format(Number(v)), 'Units']} />
              <Bar dataKey="units" name="Units" radius={[5, 5, 0, 0]}>
                {ageingChart.map((d) => (
                  <Cell key={d.name} fill={BUCKET_COLOR[d.name as AgeingBucket]} />
                ))}
                <LabelList dataKey="units" position="top" formatter={(v) => fmt.format(Number(v))} />
              </Bar>
            </BarChart>
          </ResponsiveContainer>
        </div>
      </div>

      <section className="table-panel wf-grid-panel" style={{ padding: '16px' }}>
        <h3 style={{ margin: '0 0 4px' }}>Products Discontinued but Inventory Available</h3>
        <p className="wf-subtle" style={{ margin: '0 0 10px' }}>
          Available units by product category and ageing bucket.
        </p>
        {categoryChart.length ? (
          <div style={{ maxHeight: 520, overflowY: 'auto' }}>
            <div style={{ height: Math.max(320, categoryChart.length * 26) }}>
              <ResponsiveContainer>
                <BarChart data={categoryChart} layout="vertical" margin={{ left: 24, right: 16 }}>
                  <CartesianGrid strokeDasharray="3 3" horizontal={false} />
                  <XAxis type="number" />
                  <YAxis type="category" dataKey="category" width={80} interval={0} />
                  <Tooltip formatter={(v) => fmt.format(Number(v))} />
                  <Legend />
                  {AGEING_BUCKETS.map((b) => (
                    <Bar key={b} dataKey={b} stackId="age" name={b} fill={BUCKET_COLOR[b]} />
                  ))}
                </BarChart>
              </ResponsiveContainer>
            </div>
          </div>
        ) : (
          <div className="wf-empty-cell">No discontinued stock matches these filters.</div>
        )}
      </section>

      <div className="wf-toolbar">
        <input
          className="wf-search"
          placeholder="Search SKU / product / colour / size…"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
        />
        <select className="wf-search" value={category} onChange={(e) => setCategory(e.target.value)}>
          <option value="">All categories</option>
          <option value={BLANK}>—</option>
          {categories.map((c) => (
            <option key={c} value={c}>{c}</option>
          ))}
        </select>
        <select className="wf-search" value={color} onChange={(e) => setColor(e.target.value)}>
          <option value="">All colours</option>
          <option value={BLANK}>—</option>
          {colors.map((c) => (
            <option key={c} value={c}>{c}</option>
          ))}
        </select>
        <select className="wf-search" value={bucket} onChange={(e) => setBucket(e.target.value)}>
          <option value="">All ageing</option>
          {AGEING_BUCKETS.map((b) => (
            <option key={b} value={b}>{b}</option>
          ))}
        </select>
        <select className="wf-search" value={action} onChange={(e) => setAction(e.target.value)}>
          <option value="">All actions</option>
          {RECOMMENDED_ACTIONS.map((a) => (
            <option key={a} value={a}>{a}</option>
          ))}
        </select>
        <span className="wf-chip">{fmt.format(shown.length)} SKUs</span>
        <button type="button" className="wf-btn wf-btn-ghost" onClick={exportCsv} disabled={!shown.length}>
          <Download size={14} /> CSV
        </button>
      </div>

      {actionCounts.length > 0 && (
        <div className="wf-toolbar" style={{ gap: 8 }}>
          {actionCounts.map((a) => (
            <button
              key={a.action}
              type="button"
              className={`wf-chip${action === a.action ? ' active' : ''}`}
              onClick={() => setAction(action === a.action ? '' : a.action)}
            >
              {a.action}: <strong>{a.count}</strong>
            </button>
          ))}
        </div>
      )}

      <div className="table-panel wf-grid-panel">
        <div className="table-scroll" style={{ maxHeight: 620 }}>
          <table className="wide-table wf-grid">
            <thead>
              <tr>
                <th>SKU</th>
                <th>Product</th>
                <th>Colour / size</th>
                <th className="num">Qty</th>
                <th className="num">Oldest (days)</th>
                <th>Ageing</th>
                <th>Recommended Discount</th>
                <th>Recommended action</th>
                <th className="num">Value (cost)</th>
                <th className="num">Value (MRP)</th>
              </tr>
            </thead>
            <tbody>
              {shown.map((r) => (
                <tr key={r.sku} className={r.bucket === 'Dead Stock' ? 'wf-row-over' : ''}>
                  <td className="mono">{r.sku}</td>
                  <td>{r.productName ?? r.productCode}</td>
                  <td>
                    {r.color ?? '—'}
                    <small className="wf-subtle">{r.size ?? ''}</small>
                  </td>
                  <td className="num">{fmt.format(r.qty)}</td>
                  <td className="num">{fmt.format(r.oldestDays)}</td>
                  <td>
                    <span
                      className="wf-status"
                      style={{ background: BUCKET_COLOR[r.bucket], color: '#fff' }}
                    >
                      {r.bucket}
                    </span>
                  </td>
                  <td className={r.suggestedDiscount === '—' ? 'wf-subtle' : 'strong'}>
                    {r.suggestedDiscount}
                  </td>
                  <td>
                    <span className="wf-status" style={{ color: ACTION_COLOR[r.action] }}>
                      {r.action}
                    </span>
                  </td>
                  <td className="num">{money.format(r.valueAtCost)}</td>
                  <td className="num">{money.format(r.valueAtMrp)}</td>
                </tr>
              ))}
              {!shown.length && (
                <tr>
                  <td colSpan={10} className="wf-empty-cell">
                    No discontinued stock matches these filters.
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
