'use client';

import { useState } from 'react';
import { Download } from 'lucide-react';
import { InfoDot } from '@/components/info-dot';
import { downloadCsv } from '@/lib/download';
import {
  DOQ_WEAVES,
  DOQ_WINDOW_KEYS,
  type DoqCategoryRow,
  type DoqWeave,
  type DoqWindowKey,
} from '@/lib/doq-dashboard';
import type { DoqWindowMeta } from '@/lib/forms/types';

const fmt = new Intl.NumberFormat('en-IN', { maximumFractionDigits: 0 });
const pct = (v: number) => `${(v * 100).toFixed(2)}%`;

const WINDOW_TITLES: Record<DoqWindowKey, string> = {
  d1: 'Yesterday',
  l7: 'Last 7 days',
  w1: 'Week −1',
  w2: 'Week −2',
  w3: 'Week −3',
  w4: 'Week −4',
  at: 'All time',
};

const HEADERS = [
  'CATEGORY',
  'TOTAL COUNT OF SKU',
  '% of SKUs',
  'DOQ',
  '% DOQ Contribution',
  'DOH - Current Stock',
  'DOH - IN PROCESS',
  'OOS SKU COUNT',
  'OOS SKU COUNT %',
  'SALES LEAKAGE (Rs)',
  'OOS Days',
  'OOS%',
  'IN STOCK RATE',
  'Total sku days',
];

const HEADER_INFO: Record<string, string> = {
  DOQ: 'Sum of each SKU’s window demand rate: window qty sold ÷ window in-stock days.',
  '% DOQ Contribution': 'This category’s DOQ share of the table total.',
  'DOH - Current Stock': 'Category average of (current stock ÷ SKU DOQ) — days the stock lasts.',
  'DOH - IN PROCESS': 'Category average of (in-process stock ÷ SKU DOQ).',
  'SALES LEAKAGE (Rs)': 'Σ (window OOS days × 45-day DOQ × selling price) — the fixed 45-day DOQ keeps out-of-stock items counted.',
  'OOS%': 'OOS days ÷ total SKU-days in the window.',
  'IN STOCK RATE': '1 − OOS%.',
  'Total sku days': 'Category SKU count × distinct days in the window.',
};

function csvRows(rows: DoqCategoryRow[]) {
  return rows.map((r) => [
    r.category, r.skuCount, pct(r.pctSku), r.doq, pct(r.pctDoq), r.dohStock,
    r.dohInProcess, r.oosSkuCount, pct(r.oosSkuPct), r.salesLeakage, r.oosDays,
    pct(r.oosPct), pct(r.inStockRate), r.skuDays,
  ]);
}

function WindowTable({
  kicker,
  title,
  info,
  rows,
  csvName,
  actions,
}: {
  kicker: string;
  title: string;
  info: string;
  rows: DoqCategoryRow[];
  csvName: string;
  actions?: React.ReactNode;
}) {
  return (
    <section className="panel table-panel">
      <div className="panel-title">
        <div>
          <span className="panel-kicker">{kicker}</span>
          <h3>
            {title}
            <InfoDot text={info} label={`About ${title}`} />
          </h3>
        </div>
        <span className="table-meta-actions">
          {actions}
          <button
            type="button"
            className="download-button"
            onClick={() => downloadCsv(csvName, HEADERS, csvRows(rows))}
          >
            <Download size={13} /> CSV
          </button>
        </span>
      </div>
      <div className="table-scroll">
        <table>
          <thead>
            <tr>
              {HEADERS.map((h) => (
                <th key={h}>
                  {h}
                  {HEADER_INFO[h] && <InfoDot text={HEADER_INFO[h]} label={`About ${h}`} />}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr
                key={r.category}
                style={r.category === 'TOTAL' ? { fontWeight: 700, background: 'var(--bg-surface)' } : undefined}
              >
                <td>{r.category}</td>
                <td className="tabular">{fmt.format(r.skuCount)}</td>
                <td className="tabular">{pct(r.pctSku)}</td>
                <td className="tabular">{r.doq}</td>
                <td className="tabular">{pct(r.pctDoq)}</td>
                <td className="tabular">{fmt.format(r.dohStock)}</td>
                <td className="tabular">{fmt.format(r.dohInProcess)}</td>
                <td className="tabular">{fmt.format(r.oosSkuCount)}</td>
                <td className="tabular">{pct(r.oosSkuPct)}</td>
                <td className="tabular">{fmt.format(r.salesLeakage)}</td>
                <td className="tabular">{fmt.format(r.oosDays)}</td>
                <td className="tabular">{pct(r.oosPct)}</td>
                <td className="tabular">{pct(r.inStockRate)}</td>
                <td className="tabular">{fmt.format(r.skuDays)}</td>
              </tr>
            ))}
            {!rows.length && (
              <tr>
                <td colSpan={HEADERS.length} className="wf-empty-cell">
                  No window data yet — waiting for the first bqSyncDoqWindows run.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </section>
  );
}

export function DoqDashboardClient({
  tables,
  comTables,
  meta,
  excludedCount,
}: {
  tables: Record<DoqWindowKey, Record<DoqWeave, DoqCategoryRow[]>>;
  comTables: Record<DoqWindowKey, Record<DoqWeave, DoqCategoryRow[]>>;
  meta: DoqWindowMeta | null;
  excludedCount: number;
}) {
  const [win, setWin] = useState<DoqWindowKey>('d1');
  const [weave, setWeave] = useState<DoqWeave>('All');

  const w = meta?.windows?.[win];
  const kicker = w
    ? `${w.label} · ${w.ndays} day${w.ndays > 1 ? 's' : ''}`
    : 'awaiting first sync';

  return (
    <>
      <div className="wf-toolbar" style={{ justifyContent: 'flex-start', gap: 12 }}>
        <span className="wf-chip">
          Data through <strong>{meta?.latest ?? '—'}</strong>
          <InfoDot text="Latest snapshot date in the daily inventory history the windows are computed from." />
        </span>
        {excludedCount > 0 && (
          <span className="wf-chip">
            {excludedCount} SKU{excludedCount > 1 ? 's' : ''} excluded
            <InfoDot text="The OOS Calculation tab's exclusion list applies here too — excluded SKUs are left out of every window." />
          </span>
        )}
      </div>

      {/* window pills */}
      <div className="role-tabs" role="tablist" aria-label="DOQ windows">
        {DOQ_WINDOW_KEYS.map((k) => (
          <button
            key={k}
            role="tab"
            aria-selected={win === k}
            className={win === k ? 'active' : ''}
            onClick={() => setWin(k)}
          >
            {WINDOW_TITLES[k]}
          </button>
        ))}
      </div>

      <WindowTable
        kicker={kicker}
        title={`${WINDOW_TITLES[win]} — by Product Status`}
        info="The summary breakdown: SKUs grouped by their Product State."
        rows={tables[win]?.[weave] ?? []}
        csvName={`doq-dashboard-${win}-${weave.toLowerCase()}-status`}
        actions={
          /* weave filter, mirroring the sheet's Woven / Knit tabs */
          <span className="segment" style={{ margin: 0 }}>
            {DOQ_WEAVES.map((v) => (
              <button key={v} className={weave === v ? 'active' : ''} onClick={() => setWeave(v)}>
                {v}
              </button>
            ))}
          </span>
        }
      />

      <WindowTable
        kicker={kicker}
        title={`${WINDOW_TITLES[win]} — by COM Status (detail)`}
        info="Product State + Product Class: launched SKUs classed A/B/C/D from IPDOQ (rules-master thresholds — A above 10/day, B ≥ 7, C ≥ 3, else D); NPD-family SKUs carry the literal NPD suffix instead of a class."
        rows={comTables[win]?.[weave] ?? []}
        csvName={`doq-dashboard-${win}-${weave.toLowerCase()}-com`}
      />
    </>
  );
}
