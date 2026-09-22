'use client';

import { useMemo, useState } from 'react';
import { HeaderInfo } from '@/components/header-info';
import {
  CartesianGrid,
  Legend,
  Line,
  LineChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts';
import { ChevronDown, ChevronRight, Download } from 'lucide-react';
import { InfoDot } from '@/components/info-dot';
import { downloadCsv } from '@/lib/download';
import { Notice } from '@/components/forms/form-layout';
import type { OosScope, OosSkuRow } from '@/lib/oos-summary';
import type { OosSnapshotPoint, OosSummaryData } from '@/lib/forms/queries-modules/oos-summary';

const fmt = new Intl.NumberFormat('en-IN', { maximumFractionDigits: 0 });
const pct = (v: number | null | undefined, digits = 1) => (v == null ? '—' : `${(v * 100).toFixed(digits)}%`);
const day = (iso: string | null | undefined) =>
  iso ? new Date(`${iso}T00:00:00Z`).toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC' }) : '—';

/** The category table's columns, each with the (i) that says what it counts. */
const CATEGORY_COLUMNS: { label: string; num?: boolean; info: string }[] = [
  { label: 'Category', info: "WHAT: the category as the product master holds it — the product code (SDFLK, SMFSK…) with its product name beside it. One code is one product across all its colours and sizes.\n\nHOW: every SKU is grouped under its product code. Click a row to open the list of SKUs behind it — colour, size, stock yesterday, days empty — empty ones first.\n\nUSE: the row is the product to act on; the list under it says which colour and size." },
  { label: 'SKUs', num: true, info: "WHAT: how many SKUs (colour + size) this category has on sale.\n\nWHICH: Ongoing and launched-NPD states at Main Warehouse, test SKUs excluded — the same set as the headline." },
  { label: 'OOS % 365d', num: true, info: "WHAT: the category's long-run out-of-stock share.\n\nHOW: empty SKU-days in the last 365 days ÷ (SKUs × 365). Example: 32 SKUs × 365 = 11,680 SKU-days; 2,490 empty → 21.3%.\n\nUSE: the benchmark for the two columns to its right." },
  { label: 'OOS % 45d', num: true, info: "WHAT: the category's recent out-of-stock share — the sourcing record.\n\nHOW: empty SKU-days in the last 45 days ÷ (SKUs × 45).\n\nMIND: does not fall when a SKU is refilled; it falls as empty days roll out of the window. Read 'OOS % yesterday' for the position now." },
  { label: 'OOS % yesterday', num: true, info: "WHAT: the category's position now.\n\nHOW: SKUs with zero stock on the snapshot day ÷ SKUs in the category. Example: 3 of 32 → 9.4%.\n\nRED: when this category is worse than the overall yesterday figure at the top of the page — the categories to act on first." },
  { label: 'Change vs 45d', info: "WHAT: how far yesterday sits from the category's own 45-day record.\n\nHOW: (OOS % yesterday − OOS % 45d) ÷ OOS % 45d. Example: 45-day 58.1%, yesterday 9.4% → 84% down. '—' when nothing was out of stock in the 45 days, so there is no record to compare with.\n\nREAD: green ▼ = recovering (yesterday better than the recent record). Red ▲ = worsening. Both columns it compares are on the same basis (share of SKU-days empty)." },
  { label: 'Empty SKUs 45d', num: true, info: "WHAT: how many of the category's SKUs went out of stock at some point in the last 45 days.\n\nHOW: SKUs with at least one empty day in the window — whether or not they are back in stock now.\n\nUSE: the size of the problem the team had to work through. Split into Recovered and Empty yesterday in the next columns." },
  { label: 'Empty yesterday', num: true, info: "WHAT: the category's SKUs that are empty right now.\n\nHOW: SKUs with zero stock at Main Warehouse on the snapshot day.\n\nUSE: the to-do list for this category. Which SKUs, and whether a PO is on the way, is on DOQ Calculation and the Stock Out Risk tab." },
  { label: 'Recovered', num: true, info: "WHAT: SKUs that went empty in the last 45 days and have since been refilled.\n\nHOW: empty on at least one day in the window AND stock > 0 on the snapshot day. Recovered + Empty yesterday = Empty SKUs 45d.\n\nUSE: the team's work in this category, visible the morning after each refill lands." },
  { label: 'Days on hand', num: true, info: "WHAT: how many days this category's stock lasts at its current sales rate.\n\nHOW: total stock ÷ total daily demand, over the category's SKUs that sell. Example: 650 pieces, 50 a day → 13 days.\n\n'—': none of the category's SKUs has recorded demand (nothing sold in the 45-day window), so cover cannot be worked out. Read it against the lead time in the Rules Master." },
];

/** "−50%" in green when OOS fell, "+20%" in red when it rose. */
function Change({ value }: { value: number | null }) {
  if (value == null) return <span className="oos-change is-flat">—</span>;
  const tone = value < -0.005 ? 'is-down' : value > 0.005 ? 'is-up' : 'is-flat';
  const arrow = tone === 'is-down' ? '▼' : tone === 'is-up' ? '▲' : '●';
  return (
    <span className={`oos-change ${tone}`}>
      {arrow} {Math.abs(value * 100).toFixed(0)}% {tone === 'is-down' ? 'down' : tone === 'is-up' ? 'up' : 'flat'}
    </span>
  );
}

/**
 * The one-pager. KPI numbers only; every number says what it counts. The detail tables
 * stay on the Detail view of this page and on DOQ Calculation.
 */
export function OosSummaryView({
  summary,
  snapshots,
}: {
  summary: OosSummaryData | null;
  snapshots: OosSnapshotPoint[];
}) {
  const trend = useMemo(
    () =>
      snapshots.map((p) => ({
        date: p.snapshot_date,
        label: new Date(`${p.snapshot_date}T00:00:00Z`).toLocaleDateString('en-IN', { day: 'numeric', month: 'short', timeZone: 'UTC' }),
        yesterday: p.skus ? (p.oos_yesterday / p.skus) * 100 : 0,
        window45: p.skus ? (p.oos_days_45 / (p.skus * 45)) * 100 : 0,
        oosSkus: p.oos_yesterday,
        recovered: p.recovered_45,
      })),
    [snapshots],
  );

  // Which category row is opened to show its SKUs, and which page of the table is shown.
  const [openScope, setOpenScope] = useState<string | null>(null);
  const [page, setPage] = useState(0);

  if (!summary) {
    return <Notice tone="error">The out-of-stock summary could not be loaded — the inventory-planning snapshot is not readable right now.</Notice>;
  }
  const a = summary.all;

  return (
    <div className="oos-sum">
      <div className="chip-row">
        <span className="wf-chip">
          Position as of <strong>{day(summary.asOf)}</strong>
          <InfoDot text={"WHAT: the date of the stock position this page is built on. Stock is copied from EasyEcom once a night, so the freshest position is always the day before.\n\nSO: wherever this page says 'yesterday', it means this date. If the date is older than yesterday, the nightly sync has not run — check Sync Health."} />
        </span>
        <span className="wf-chip">
          {summary.warehouse} · {fmt.format(a.skus)} SKUs on sale
          <InfoDot text={"WHAT: how many SKUs (colour + size) these numbers cover, and which stock.\n\nWHICH SKUs: product state Ongoing, or NPD that has launched. Discontinued, To-Be-Discontinued and NPD-Not-Launched are left out — they cannot be 'out of stock' against demand they do not have. Test SKUs on the shared exclusion list are left out too.\n\nWHICH STOCK: Main Warehouse only. It is the warehouse online orders ship from and the only one with a daily demand figure. Store, FBA and Holisol stock is not counted — a SKU with 0 at Main and 5 in a store counts as out of stock here."} />
        </span>
        {summary.excludedSkus > 0 && <span className="wf-chip">{summary.excludedSkus} test SKUs excluded</span>}
      </div>

      {/* The headline: the same measure over three windows, so the fall is a real comparison. */}
      <section className="panel oos-sum-panel">
        <div className="panel-title">
          <div>
            <span className="panel-kicker">Share of SKU-days out of stock</span>
            <h3>
              OOS % — last 365 days · last 45 days · yesterday
              <InfoDot text={"WHAT: the share of selling opportunity lost to empty shelves, over three windows.\n\nHOW: count every day a SKU had no stock (one SKU × one empty day = one SKU-day), divide by all the SKU-days in the window. Example: 10 SKUs over 45 days = 450 SKU-days; 90 of them empty → 20%. Over one day it is simply empty SKUs ÷ SKUs: 1 of 10 empty yesterday → 10%.\n\nWHY THREE WINDOWS: 365 days is the long-run benchmark, 45 days is the recent record, yesterday is the position now. All three are on the same basis, so the pill on the right (yesterday vs 45 days) is a true fall or rise: 20% → 10% reads as 50% down."} label="About OOS %" />
            </h3>
          </div>
          <Change value={a.changeVs45} />
        </div>
        <div className="oos-kpi-grid three">
          <div className="oos-kpi">
            <span>
              Last 365 days
              <InfoDot text={"WHAT: the long-run benchmark — how much of the last year the range was out of stock.\n\nHOW: empty SKU-days in the last 365 days ÷ (SKUs × 365). The count underneath is SKUs that were empty on at least one day in the year.\n\nUSE: compare the 45-day and yesterday figures against this. Below it = better than the year's norm; above it = worse."} label="About last 365 days" />
            </span>
            <strong>{pct(a.pct365)}</strong>
            <small>{fmt.format(a.oos365)} SKUs empty on at least one day</small>
          </div>
          <div className="oos-kpi">
            <span>
              Last 45 days
              <InfoDot text={"WHAT: the recent record — how much of the last 45 days the range was out of stock. This is the sourcing / replenishment team's efficiency measure.\n\nHOW: empty SKU-days in the last 45 days ÷ (SKUs × 45). The count underneath is SKUs that were empty on at least one of those days.\n\nMIND: by design this does NOT drop the day a SKU is refilled. A SKU empty on 1 Sep stays in this count until 1 Sep rolls out of the window, 45 days later. To see today's improvement, read 'Yesterday'."} label="About last 45 days" />
            </span>
            <strong>{pct(a.pct45)}</strong>
            <small>{fmt.format(a.oos45)} SKUs empty on at least one day · the sourcing record</small>
          </div>
          <div className="oos-kpi is-now">
            <span>
              Yesterday
              <InfoDot text={"WHAT: the position now — how much of the range had no stock as of the snapshot day.\n\nHOW: SKUs with zero stock at Main Warehouse ÷ SKUs. The count underneath is those SKUs.\n\nUSE: this is the trend number. When the team brings 50 empty SKUs down to 30, the 45-day figure will not move for weeks, but this one shows it the next morning. Compare it with the 45-day figure via the pill on the right."} label="About yesterday" />
            </span>
            <strong>{pct(a.pctYesterday)}</strong>
            <small>{fmt.format(a.oosYesterday)} SKUs with no stock · the position now</small>
          </div>
        </div>
        <p className="wf-subtle oos-sum-read">
          {a.changeVs45 == null
            ? 'Nothing was out of stock in the last 45 days, so there is no change to read.'
            : `Out of stock ran at ${pct(a.pct45)} of SKU-days over the last 45 days and stood at ${pct(a.pctYesterday)} yesterday — ${Math.abs(
                a.changeVs45 * 100,
              ).toFixed(0)}% ${a.changeVs45 < 0 ? 'lower' : 'higher'}.`}
        </p>
      </section>

      <div className="oos-kpi-grid four">
        <div className="oos-kpi panel">
          <span>
            In-stock rate
            <InfoDot text={"WHAT: the other side of OOS % — the share of the range that WAS on the shelf.\n\nHOW: 1 − OOS %. Yesterday: SKUs with stock ÷ SKUs. Last 45 days: stocked SKU-days ÷ (SKUs × 45). Example: 139 of 2,479 SKUs empty → 94.4% in stock.\n\nUSE: the number to quote upwards. Higher is better; the 45-day figure beside it says whether yesterday was a good day or the norm."} label="About in-stock rate" />
          </span>
          <strong>{pct(1 - a.pctYesterday)}</strong>
          <small>yesterday · {pct(1 - a.pct45)} over the last 45 days</small>
        </div>
        <div className="oos-kpi panel">
          <span>
            Recovered from out of stock
            <InfoDot text={"WHAT: SKUs that went out of stock in the last 45 days and have since been refilled.\n\nHOW: empty on at least one day in the last 45 days AND stock > 0 on the snapshot day. Recovered + still out of stock = every SKU that went empty in the window.\n\nUSE: this is the team's work made visible. The 45-day OOS count cannot fall until the window rolls; this count rises the morning after each refill lands."} label="About recovered" />
          </span>
          <strong>{fmt.format(a.recovered45)}</strong>
          <small>SKUs empty at some point in the last 45 days that had stock yesterday</small>
        </div>
        <div className="oos-kpi panel">
          <span>
            Still out of stock
            <InfoDot text={"WHAT: the SKUs that are empty right now — the to-do list.\n\nHOW: SKUs with zero stock at Main Warehouse on the snapshot day, shown against every SKU that went empty in the last 45 days. Recovered + still out = that 45-day count.\n\nUSE: the detail — which SKUs, and whether a PO is already on the way — is on DOQ Calculation and the Main Dashboard's Stock Out Risk tab."} label="About still out of stock" />
          </span>
          <strong>{fmt.format(a.oosYesterday)}</strong>
          <small>of the {fmt.format(a.oos45)} SKUs that went empty in the last 45 days</small>
        </div>
        <div className="oos-kpi panel">
          <span>
            Days on hand
            <InfoDot text={"WHAT: how many days the stock on hand would last if sales continued at the current rate and nothing arrived.\n\nHOW: total stock ÷ total daily demand, over SKUs that actually sell (daily demand above 0). Example: 4,400 pieces in stock, 100 pieces a day sold → 44 days. SKUs with no sales are left out, otherwise dead stock would make cover look better than it is.\n\nUSE: read it against the lead time — a FOB order takes about 90 days to land, so 44 days of cover means the next order is already late unless it is in process. The Rules Master holds the lead times."} label="About days on hand" />
          </span>
          <strong>{a.daysOnHand == null ? '—' : fmt.format(Math.round(a.daysOnHand))}</strong>
          <small>days the stock lasts at the current sales rate, over SKUs that sell</small>
        </div>
      </div>

      <section className="panel oos-sum-panel">
        <div className="panel-title">
          <div>
            <span className="panel-kicker">Trend</span>
            <h3>
              OOS % by day
              <InfoDot text={"WHAT: OOS % day by day, so the direction is visible — not just today's number.\n\nHOW: the nightly stock feed keeps only the latest day, so this page saves its own point each day, the first time anyone opens it. The red line is each day's position (empty SKUs ÷ SKUs); the blue line is the rolling 45-day record.\n\nREAD: red falling under blue = the team is improving on its recent record. History starts from 21 Sep 2026, the first day recorded, so the chart is short at first and fills in daily."} label="About the trend" />
            </h3>
          </div>
          <span className="wf-subtle">{trend.length} day{trend.length === 1 ? '' : 's'} recorded</span>
        </div>
        {trend.length >= 2 ? (
          <div className="oos-trend">
            <ResponsiveContainer>
              <LineChart data={trend} margin={{ top: 8, right: 16, bottom: 4, left: 0 }}>
                <CartesianGrid strokeDasharray="3 3" />
                <XAxis dataKey="label" tick={{ fontSize: 10 }} minTickGap={24} />
                <YAxis tick={{ fontSize: 10 }} unit="%" width={44} />
                <Tooltip formatter={(v, name) => [`${Number(v ?? 0).toFixed(1)}%`, String(name ?? '')]} />
                <Legend />
                <Line type="monotone" dataKey="yesterday" name="OOS % that day" stroke="#c0392b" strokeWidth={2} dot={false} />
                <Line type="monotone" dataKey="window45" name="OOS % last 45 days" stroke="#4d6fa9" strokeWidth={2} dot={false} />
              </LineChart>
            </ResponsiveContainer>
          </div>
        ) : (
          <p className="wf-subtle oos-sum-read">
            The trend needs at least two recorded days. Today’s position ({day(summary.asOf)}) has been recorded; the line
            starts drawing from tomorrow.
          </p>
        )}
      </section>

      <section className="panel table-panel">
        <div className="panel-title">
          <div>
            <span className="panel-kicker">By category — click a row for its SKUs</span>
            <h3>
              OOS % per category — 365 days · 45 days · yesterday
              <InfoDot text={"WHAT: the headline numbers broken down by category, so it is clear WHERE stock-outs sit.\n\nHOW: the same three windows and the same change, computed within each category — the product code as the product master holds it (SDFLK = Airy Linen Long Kurta, and so on). Sorted with the worst 'yesterday' at the top.\n\nUSE: a category well above the overall OOS % yesterday (shown in red) is where the next POs should go. Click it to see which colours and sizes are empty. The change column says whether that category is already recovering."} label="About the category table" />
            </h3>
          </div>
        </div>
        <p className="wf-subtle oos-sum-read oos-coverage">
          <strong>{fmt.format(summary.categories.length)} product codes</strong> — every code with a SKU on sale
          (Ongoing or launched NPD) at {summary.warehouse}.
          {summary.codesLeftOut.length ? (
            <>
              {' '}Not in this table:{' '}
              {summary.codesLeftOut.map((x, i) => (
                <span key={x.state}>
                  {i ? ' · ' : ''}
                  {fmt.format(x.codes)} {x.state}
                </span>
              ))}
              {' '}— those states cannot be out of stock against demand they do not have.
            </>
          ) : null}
        </p>
        <div className="table-scroll">
          <table>
            <thead>
              <tr>
                {CATEGORY_COLUMNS.map((c) => (
                  <th key={c.label} className={c.num ? 'num' : undefined}>
                    {c.label}
                    <InfoDot text={c.info} label={`About ${c.label}`} />
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {summary.categories.slice(page * PAGE_SIZE, (page + 1) * PAGE_SIZE).map((c: OosScope) => (
                <CategoryRow
                  key={c.scope}
                  c={c}
                  overallYesterday={a.pctYesterday}
                  skus={summary.skusByScope[c.scope] ?? []}
                  open={openScope === c.scope}
                  onToggle={() => setOpenScope((cur) => (cur === c.scope ? null : c.scope))}
                />
              ))}
              {!summary.categories.length && (
                <tr>
                  <td colSpan={10} className="wf-empty-cell">
                    No SKUs on sale in the snapshot.
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
        {summary.categories.length > PAGE_SIZE && (
          <Pager
            page={page}
            pages={Math.ceil(summary.categories.length / PAGE_SIZE)}
            total={summary.categories.length}
            onPage={(p) => {
              setPage(p);
              setOpenScope(null);
            }}
          />
        )}
      </section>
    </div>
  );
}

/** Rows per page of the category table. */
const PAGE_SIZE = 15;

function Pager({ page, pages, total, onPage }: { page: number; pages: number; total: number; onPage: (p: number) => void }) {
  const from = page * PAGE_SIZE + 1;
  const to = Math.min(total, (page + 1) * PAGE_SIZE);
  return (
    <div className="oos-pager">
      <span className="wf-subtle">
        Showing {from}–{to} of {total} product codes
      </span>
      <span className="oos-pager-btns">
        <button type="button" className="wf-btn wf-btn-ghost wf-btn-sm" disabled={page === 0} onClick={() => onPage(page - 1)}>
          ← Previous
        </button>
        {Array.from({ length: pages }, (_, i) => (
          <button
            key={i}
            type="button"
            className={`wf-btn wf-btn-sm${i === page ? ' wf-btn-primary' : ' wf-btn-ghost'}`}
            aria-current={i === page ? 'page' : undefined}
            onClick={() => onPage(i)}
          >
            {i + 1}
          </button>
        ))}
        <button type="button" className="wf-btn wf-btn-ghost wf-btn-sm" disabled={page >= pages - 1} onClick={() => onPage(page + 1)}>
          Next →
        </button>
      </span>
    </div>
  );
}

const STATE_LABEL: Record<OosSkuRow['state'], string> = {
  empty: 'No stock yesterday',
  recovered: 'Was empty, back in stock',
  ok: 'In stock all 45 days',
};

/** One category row; click opens the SKUs behind it, empty ones first. */
function CategoryRow({
  c,
  overallYesterday,
  skus,
  open,
  onToggle,
}: {
  c: OosScope;
  overallYesterday: number;
  skus: OosSkuRow[];
  open: boolean;
  onToggle: () => void;
}) {
  const empty = skus.filter((s) => s.state === 'empty').length;
  return (
    <>
      <tr className={`oos-cat-row${open ? ' is-open' : ''}`} onClick={onToggle} role="button" aria-expanded={open}>
        <td>
          <span className="oos-cat-name">
            {open ? <ChevronDown size={13} /> : <ChevronRight size={13} />}
            <b className="mono">{c.scope}</b>
            {c.label ? <small className="wf-subtle">{c.label}</small> : null}
          </span>
        </td>
        <td className="num tabular">{fmt.format(c.skus)}</td>
        <td className="num tabular">{pct(c.pct365)}</td>
        <td className="num tabular">{pct(c.pct45)}</td>
        <td className={`num tabular${c.pctYesterday > overallYesterday ? ' oos-worse' : ''}`}>{pct(c.pctYesterday)}</td>
        <td>
          <Change value={c.changeVs45} />
        </td>
        <td className="num tabular">{fmt.format(c.oos45)}</td>
        <td className="num tabular">{fmt.format(c.oosYesterday)}</td>
        <td className="num tabular">{fmt.format(c.recovered45)}</td>
        <td className="num tabular">{c.daysOnHand == null ? '—' : fmt.format(Math.round(c.daysOnHand))}</td>
      </tr>
      {open && (
        <tr className="oos-cat-detail">
          <td colSpan={10}>
            <div className="oos-sku-head">
              <span>
                <strong>{fmt.format(skus.length)} SKUs</strong> in {c.scope}
                {c.label ? ` · ${c.label}` : ''} — {fmt.format(empty)} with no stock yesterday, listed first
              </span>
              <button
                type="button"
                className="download-button"
                onClick={(e) => {
                  e.stopPropagation();
                  downloadCsv(
                    `oos-${c.scope.toLowerCase()}-skus`,
                    ['SKU', 'Product', 'Colour', 'Size', 'Stock yesterday', 'Days empty (45d)', 'Days empty (365d)', 'Daily demand', 'State'],
                    skus.map((s) => [s.sku, s.name, s.variant, s.size, s.stock, s.oosDays45, s.oosDays365, s.dailyDemand, STATE_LABEL[s.state]]),
                  );
                }}
              >
                <Download size={13} /> CSV
              </button>
            </div>
            <div className="table-scroll oos-sku-scroll">
              <table>
                <thead>
                  <tr>
                    <th>SKU <HeaderInfo label="SKU" /></th>
                    <th>Colour <HeaderInfo label="Colour" /></th>
                    <th>Size <HeaderInfo label="Size" /></th>
                    <th className="num">Stock yesterday <HeaderInfo label="Stock yesterday" /></th>
                    <th className="num">Days empty, last 45 <HeaderInfo label="Days empty, last 45" /></th>
                    <th className="num">Days empty, last 365 <HeaderInfo label="Days empty, last 365" /></th>
                    <th className="num">Sells a day <HeaderInfo label="Sells a day" /></th>
                    <th>Where it stands <HeaderInfo label="Where it stands" /></th>
                  </tr>
                </thead>
                <tbody>
                  {skus.map((s) => (
                    <tr key={s.sku} className={`oos-sku-${s.state}`}>
                      <td className="mono">{s.sku}</td>
                      <td className="mono">{s.variant || '—'}</td>
                      <td>{s.size || '—'}</td>
                      <td className="num tabular">{fmt.format(s.stock)}</td>
                      <td className="num tabular">{s.oosDays45}</td>
                      <td className="num tabular">{s.oosDays365}</td>
                      <td className="num tabular">{s.dailyDemand ? (Math.round(s.dailyDemand * 10) / 10).toString() : '—'}</td>
                      <td>
                        <span className={`oos-sku-state is-${s.state}`}>{STATE_LABEL[s.state]}</span>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </td>
        </tr>
      )}
    </>
  );
}
