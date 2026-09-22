'use client';

import { useMemo } from 'react';
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
import { InfoDot } from '@/components/info-dot';
import { Notice } from '@/components/forms/form-layout';
import type { OosScope } from '@/lib/oos-summary';
import type { OosSnapshotPoint, OosSummaryData } from '@/lib/forms/queries-modules/oos-summary';

const fmt = new Intl.NumberFormat('en-IN', { maximumFractionDigits: 0 });
const pct = (v: number | null | undefined, digits = 1) => (v == null ? '—' : `${(v * 100).toFixed(digits)}%`);
const day = (iso: string | null | undefined) =>
  iso ? new Date(`${iso}T00:00:00Z`).toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC' }) : '—';

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

  if (!summary) {
    return <Notice tone="error">The out-of-stock summary could not be loaded — the inventory-planning snapshot is not readable right now.</Notice>;
  }
  const a = summary.all;

  return (
    <div className="oos-sum">
      <div className="chip-row">
        <span className="wf-chip">
          Position as of <strong>{day(summary.asOf)}</strong>
          <InfoDot text="The latest nightly inventory-planning snapshot. 'Yesterday' everywhere on this page means this day." />
        </span>
        <span className="wf-chip">
          {summary.warehouse} · {fmt.format(a.skus)} SKUs on sale
          <InfoDot text="Main Warehouse only — the warehouse the demand figures belong to. SKUs in the Ongoing and launched-NPD states; discontinued, to-be-discontinued and not-yet-launched SKUs are out, as are the test SKUs on the shared exclusion list." />
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
              <InfoDot text="Every SKU-day counts once: over 45 days that is empty SKU-days ÷ (SKUs × 45); over one day it is simply empty SKUs ÷ SKUs. Same basis in every column, so the change is like for like." label="About OOS %" />
            </h3>
          </div>
          <Change value={a.changeVs45} />
        </div>
        <div className="oos-kpi-grid three">
          <div className="oos-kpi">
            <span>Last 365 days</span>
            <strong>{pct(a.pct365)}</strong>
            <small>{fmt.format(a.oos365)} SKUs empty on at least one day</small>
          </div>
          <div className="oos-kpi">
            <span>Last 45 days</span>
            <strong>{pct(a.pct45)}</strong>
            <small>{fmt.format(a.oos45)} SKUs empty on at least one day · the sourcing record</small>
          </div>
          <div className="oos-kpi is-now">
            <span>Yesterday</span>
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
          <span>In-stock rate</span>
          <strong>{pct(1 - a.pctYesterday)}</strong>
          <small>yesterday · {pct(1 - a.pct45)} over the last 45 days</small>
        </div>
        <div className="oos-kpi panel">
          <span>Recovered from out of stock</span>
          <strong>{fmt.format(a.recovered45)}</strong>
          <small>SKUs empty at some point in the last 45 days that had stock yesterday</small>
        </div>
        <div className="oos-kpi panel">
          <span>Still out of stock</span>
          <strong>{fmt.format(a.oosYesterday)}</strong>
          <small>of the {fmt.format(a.oos45)} SKUs that went empty in the last 45 days</small>
        </div>
        <div className="oos-kpi panel">
          <span>Days on hand</span>
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
              <InfoDot text="One point per data day, recorded the first time this page is opened for that day. The 45-day line moves slowly (it is the rolling record); the yesterday line is the position each day. History starts from the day this page went live." label="About the trend" />
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
            <span className="panel-kicker">By category</span>
            <h3>
              OOS % per category — 365 days · 45 days · yesterday
              <InfoDot text="Same measures as the headline, per category (the product master's sub-category). Worst yesterday at the top." label="About the category table" />
            </h3>
          </div>
        </div>
        <div className="table-scroll">
          <table>
            <thead>
              <tr>
                <th>Category</th>
                <th className="num">SKUs</th>
                <th className="num">OOS % 365d</th>
                <th className="num">OOS % 45d</th>
                <th className="num">OOS % yesterday</th>
                <th>Change vs 45d</th>
                <th className="num">Empty SKUs 45d</th>
                <th className="num">Empty yesterday</th>
                <th className="num">Recovered</th>
                <th className="num">Days on hand</th>
              </tr>
            </thead>
            <tbody>
              {summary.categories.map((c: OosScope) => (
                <tr key={c.scope}>
                  <td>{c.scope}</td>
                  <td className="num tabular">{fmt.format(c.skus)}</td>
                  <td className="num tabular">{pct(c.pct365)}</td>
                  <td className="num tabular">{pct(c.pct45)}</td>
                  <td className={`num tabular${c.pctYesterday > a.pctYesterday ? ' oos-worse' : ''}`}>{pct(c.pctYesterday)}</td>
                  <td>
                    <Change value={c.changeVs45} />
                  </td>
                  <td className="num tabular">{fmt.format(c.oos45)}</td>
                  <td className="num tabular">{fmt.format(c.oosYesterday)}</td>
                  <td className="num tabular">{fmt.format(c.recovered45)}</td>
                  <td className="num tabular">{c.daysOnHand == null ? '—' : fmt.format(Math.round(c.daysOnHand))}</td>
                </tr>
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
      </section>
    </div>
  );
}
