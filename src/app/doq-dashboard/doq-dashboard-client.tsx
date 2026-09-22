'use client';

import { useState, useTransition } from 'react';
import { Download, Plus, X, Ban } from 'lucide-react';
import { InfoDot } from '@/components/info-dot';
import { Notice } from '@/components/forms/form-layout';
import { reloadWithToast } from '@/lib/toast';
import { addOosExclusion, removeOosExclusion } from '@/lib/forms/actions';
import { downloadCsv } from '@/lib/download';
import {
  DOQ_WEAVES,
  DOQ_WINDOW_KEYS,
  type DoqCategoryRow,
  type DoqWeave,
  type DoqWindowKey,
} from '@/lib/doq-dashboard';
import type { DoqWindowMeta, OosSkuExclusion } from '@/lib/forms/types';
import type { OosSnapshotPoint, OosSummaryData } from '@/lib/forms/queries-modules/oos-summary';
import { OosSummaryView } from './oos-summary';

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
  DOQ: "WHAT: DOQ — Daily Order Quantity — how many pieces a day this group sells.\n\nHOW: for each SKU, pieces sold in the window ÷ days it was IN STOCK in the window (empty days are not held against it), then summed over the group. Example: 90 sold over 30 stocked days → 3 a day for that SKU.\n\nUSE: the demand rate every reorder quantity is built on. Read the 45-day version on Replenishment (IPDOQ) for ordering.",
  '% DOQ Contribution': "WHAT: how much of total daily demand this group represents.\n\nHOW: the group's DOQ ÷ the table's total DOQ. Example: 120 of 600 a day → 20%.\n\nUSE: where the sales are — the groups to keep in stock first.",
  'DOH - Current Stock': "WHAT: DOH — Days On Hand — how many days the stock lasts at the current sales rate.\n\nHOW: per SKU, current stock ÷ its DOQ; averaged over the group. Example: 300 in stock, 5 a day → 60 days.\n\nUSE: read against lead time (Rules Master: Job Work 30, E-FOB 45, FOB 90 days). Below the lead time, the next order is already late unless it is in process.",
  'DOH - IN PROCESS': "WHAT: how many extra days the pieces on order will add.\n\nHOW: per SKU, in-process (on order, not received) ÷ its DOQ; averaged over the group.\n\nUSE: DOH stock + DOH in process = total cover. If the sum is still under the lead time, order more now.",
  'SALES LEAKAGE (Rs)': "WHAT: the sales lost because SKUs were out of stock — in rupees.\n\nHOW: for each SKU, days out of stock in the window × its 45-day DOQ × selling price, summed. The 45-day DOQ is used (not the window's) so a SKU that was empty the whole window still counts. Example: 10 empty days × 3 a day × ₹899 → ₹26,970 lost on one SKU.\n\nUSE: the cost of the stock-out problem, in the language finance uses.",
  'OOS%': "WHAT: OOS % — the share of selling opportunity lost to empty shelves in this window.\n\nHOW: empty SKU-days ÷ (SKUs × days in the window). Example: 10 SKUs over 7 days = 70 SKU-days; 14 empty → 20%.\n\nUSE: same basis as the Summary page's OOS %. Lower is better.",
  'IN STOCK RATE': "WHAT: the share of the window the group WAS on the shelf.\n\nHOW: 1 − OOS %. Example: OOS 20% → in-stock rate 80%.\n\nUSE: the positive way to quote the same number.",
  'Total sku days': "WHAT: the denominator behind OOS % — every SKU × every day in the window.\n\nHOW: SKUs in the group × days in the window. Example: 10 SKUs × 7 days = 70.\n\nUSE: shown so the OOS % can be checked by hand: OOS days ÷ this.",
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

/** Add/remove SKUs to exclude from every table on this page. Shared with OOS Calculation.
 *  On save the page reloads and the tables re-aggregate without the excluded SKUs. */
function ExclusionManager({ exclusions, editable }: { exclusions: OosSkuExclusion[]; editable: boolean }) {
  const [sku, setSku] = useState('');
  const [reason, setReason] = useState('');
  const [err, setErr] = useState<string | null>(null);
  const [busy, start] = useTransition();

  function add() {
    const s = sku.trim();
    if (!s) return;
    setErr(null);
    const fd = new FormData();
    fd.set('sku', s);
    fd.set('reason', reason.trim());
    start(async () => {
      const r = await addOosExclusion(fd);
      if (r.ok) reloadWithToast(r.message);
      else setErr(r.error);
    });
  }
  function remove(s: string) {
    setErr(null);
    const fd = new FormData();
    fd.set('sku', s);
    start(async () => {
      const r = await removeOosExclusion(fd);
      if (r.ok) reloadWithToast(r.message);
      else setErr(r.error);
    });
  }

  return (
    <details className="panel" style={{ padding: '12px 16px', marginBottom: 14 }} open={editable && exclusions.length === 0}>
      <summary style={{ cursor: 'pointer', fontWeight: 600, display: 'flex', alignItems: 'center', gap: 8 }}>
        <Ban size={15} /> Excluded SKUs ({exclusions.length})
        <InfoDot text={"WHAT: SKUs deliberately left out of every table on this page and on DOQ Calculation.\n\nHOW: the shared exclusion list — test SKUs, samples, anything that should not count as a stock-out.\n\nUSE: add or remove any time; the tables update on save. Keep it short — every SKU here is invisible to the OOS numbers."} />
      </summary>

      <div style={{ marginTop: 12 }}>
        {err && <Notice tone="error">{err}</Notice>}

        {editable && (
          <div className="wf-issue-row wf-issue-row-wrap" style={{ marginBottom: 10 }}>
            <input
              className="wf-mini-input"
              placeholder="SKU to exclude (e.g. SDRPTBR_L)"
              value={sku}
              onChange={(e) => setSku(e.target.value)}
              onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); add(); } }}
            />
            <input
              className="wf-mini-input"
              placeholder="reason (optional)"
              value={reason}
              onChange={(e) => setReason(e.target.value)}
              onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); add(); } }}
            />
            <button type="button" className="wf-btn wf-btn-primary wf-btn-sm" disabled={busy || !sku.trim()} onClick={add}>
              <Plus size={13} /> Exclude
            </button>
          </div>
        )}

        {exclusions.length === 0 ? (
          <p className="wf-subtle">No SKUs excluded — every SKU is included in the tables below.</p>
        ) : (
          <div className="chip-row">
            {exclusions.map((e) => (
              <span key={e.sku} className="wf-chip" title={[e.reason, e.added_by ? `by ${e.added_by}` : null].filter(Boolean).join(' · ')}>
                <span className="mono">{e.sku}</span>
                {e.reason ? <span className="wf-subtle"> — {e.reason}</span> : null}
                {editable && (
                  <button type="button" className="wf-icon-btn" aria-label={`Remove ${e.sku}`} disabled={busy} onClick={() => remove(e.sku)} style={{ marginLeft: 4 }}>
                    <X size={12} />
                  </button>
                )}
              </span>
            ))}
          </div>
        )}
      </div>
    </details>
  );
}

export function DoqDashboardClient({
  tables,
  comTables,
  meta,
  exclusions,
  editable,
  summary = null,
  snapshots = [],
}: {
  tables: Record<DoqWindowKey, Record<DoqWeave, DoqCategoryRow[]>>;
  comTables: Record<DoqWindowKey, Record<DoqWeave, DoqCategoryRow[]>>;
  meta: DoqWindowMeta | null;
  exclusions: OosSkuExclusion[];
  editable: boolean;
  /** The one-pager (KPI numbers only) and its daily history. */
  summary?: OosSummaryData | null;
  snapshots?: OosSnapshotPoint[];
}) {
  const [win, setWin] = useState<DoqWindowKey>('d1');
  const [weave, setWeave] = useState<DoqWeave>('All');
  // Summary first: the numbers people quote. Detail is the window tables underneath.
  const [view, setView] = useState<'summary' | 'detail'>('summary');

  const w = meta?.windows?.[win];
  const kicker = w
    ? `${w.label} · ${w.ndays} day${w.ndays > 1 ? 's' : ''}`
    : 'awaiting first sync';

  return (
    <>
      <div className="role-tabs" role="tablist" aria-label="OOS views">
        <button role="tab" aria-selected={view === 'summary'} className={view === 'summary' ? 'active' : ''} onClick={() => setView('summary')}>
          Summary — one page
        </button>
        <button role="tab" aria-selected={view === 'detail'} className={view === 'detail' ? 'active' : ''} onClick={() => setView('detail')}>
          Detail — windows
        </button>
      </div>

      {view === 'summary' && <OosSummaryView summary={summary} snapshots={snapshots} />}

      {view === 'detail' && (
      <>
      <div className="chip-row">
        <span className="wf-chip">
          Data through <strong>{meta?.latest ?? '—'}</strong>
          <InfoDot text={"WHAT: the last day of data in these windows.\n\nHOW: the latest date in the daily inventory history the windows are computed from.\n\nUSE: 'Yesterday' means this date. If it is older than yesterday, the sync has not run — check Sync Health."} />
        </span>
        {exclusions.length > 0 && (
          <span className="wf-chip">
            {exclusions.length} SKU{exclusions.length > 1 ? 's' : ''} excluded
            <InfoDot text={"WHAT: how many SKUs are being left out of the tables below.\n\nHOW: the shared exclusion list, managed in the Excluded SKUs panel on this page; DOQ Calculation uses the same list.\n\nUSE: if a number looks too good, check nothing real is on this list."} />
          </span>
        )}
      </div>

      <ExclusionManager exclusions={exclusions} editable={editable} />

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
        info={"WHAT: the window's numbers grouped by Product State — Ongoing, NPD, To Be Discontinued, and so on.\n\nHOW: each SKU counted under its state from the product master; the TOTAL row is all of them.\n\nUSE: Ongoing is the row that matters for stock-outs; Discontinued being out of stock is expected."}
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
        info={"WHAT: the same numbers split finer — by Product State AND sales class.\n\nHOW: launched SKUs are classed by how fast they sell (IPDOQ): A above 10 a day, B 7 or more, C 3 or more, else D — thresholds in Rules Master. NPD-family SKUs show 'NPD' instead of a class because they have no sales history yet.\n\nUSE: 'Ongoing · A' out of stock is the row to act on first; 'To Be Discontinued · D' is the row to leave alone. The class is about sales speed only — D does NOT mean discontinued."}
        rows={comTables[win]?.[weave] ?? []}
        csvName={`doq-dashboard-${win}-${weave.toLowerCase()}-com`}
      />
      </>
      )}
    </>
  );
}
