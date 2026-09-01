'use client';

/**
 * Cross-tab decision cards for the main Dashboard tab — the "so what" layer
 * above the descriptive KPIs. Each card combines data from two or more modules
 * and answers "what needs attention" / "what decision does this support", with
 * named items and a click-through to the underlying detail. Thresholds come
 * from the editable Rules Master (sd_analytics_rule), not hardcoded, and every
 * card distinguishes "data not available" from a genuine zero.
 */

import { useMemo } from 'react';
import {
  AlertTriangle,
  ArrowUpRight,
  Ban,
  CheckCheck,
  Factory,
  IndianRupee,
  PackageX,
  Scale,
  Target,
  TrendingUp,
} from 'lucide-react';
import type { LucideIcon } from 'lucide-react';
import {
  Area,
  AreaChart,
  CartesianGrid,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts';
import { buildTrackerRows, buildVendorRollups, istToday } from '@/lib/business-logic';
import { InfoDot } from './info-dot';
import type { DashboardData } from '@/lib/types';
import type { AnalyticsExtras } from '@/lib/forms/types';
import type { TabId } from './side-nav';

const money = new Intl.NumberFormat('en-IN', {
  style: 'currency',
  currency: 'INR',
  maximumFractionDigits: 0,
});
const fmt = new Intl.NumberFormat('en-IN', { maximumFractionDigits: 0 });
const key = (s: string | null | undefined) => (s ?? '').trim().toLowerCase();

/** Value at quantile q (0..1) of a sorted-ascending numeric array. */
function quantile(sortedAsc: number[], q: number): number {
  if (!sortedAsc.length) return 0;
  const idx = Math.min(sortedAsc.length - 1, Math.max(0, Math.floor(q * sortedAsc.length)));
  return sortedAsc[idx];
}

type Tone = 'red' | 'amber' | 'green' | 'neutral';

/** Shared DAM card shell: top-border tone, icon chip, info-dot, click-through. */
function AnaCard({
  title,
  icon: Icon,
  info,
  tone = 'neutral',
  span = 4,
  onClick,
  href,
  children,
}: {
  title: string;
  icon: LucideIcon;
  info: string;
  tone?: Tone;
  span?: number;
  onClick?: () => void;
  href?: string;
  children: React.ReactNode;
}) {
  const go = onClick ?? (href ? () => { window.location.href = href; } : undefined);
  return (
    <section
      className={`ana-card ana-span${span} ana-${tone}${go ? ' clickable' : ''}`}
      role={go ? 'button' : undefined}
      tabIndex={go ? 0 : undefined}
      onClick={go}
      onKeyDown={go ? (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); go(); } } : undefined}
    >
      <div className="ana-head">
        <span className="ana-head-left">
          <span className="ana-icon"><Icon size={13} strokeWidth={2} /></span>
          <span className="ana-label">{title}</span>
        </span>
        <InfoDot text={info} label={`About ${title}`} />
      </div>
      {children}
      {go && <ArrowUpRight className="ana-go" size={15} />}
    </section>
  );
}

const NoData = ({ text }: { text: string }) => <p className="ana-nodata">{text}</p>;

export function AnalyticsCards({
  data,
  rules,
  extras,
  onTab,
}: {
  data: DashboardData;
  rules: Record<string, number>;
  extras?: AnalyticsExtras | null;
  onTab: (id: TabId) => void;
}) {
  const today = istToday();

  const tracker = useMemo(
    () => buildTrackerRows(data.pendingPos, data.vendorTypes, data.vendorMasters, data.tnaRecords, today),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [data],
  );

  const rollups = useMemo(() => {
    const capacityByVendor = new Map(
      (data.vendorCapacity ?? []).map((c) => [
        key(c.vendor_code),
        { machines: Number(c.machines_allocated) || 0, karigar: Number(c.active_karigar) || 0 },
      ]),
    );
    return buildVendorRollups(
      data.pendingPos, data.vendorTypes, data.vendorMasters, data.tnaRecords, today, capacityByVendor,
    );
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [data]);

  /* ---- 1.1 Capital at Risk ---- */
  const tnaDataPresent = data.tnaRecords.length > 0;
  const values = tracker.map((r) => r.pendingValue).filter((v) => v > 0).sort((a, b) => a - b);
  const valueThreshold = quantile(values, rules.capital_risk_quantile ?? 0.75);
  const atRisk = tracker
    .filter((r) => r.highRisk && r.pendingValue >= valueThreshold)
    .sort((a, b) => b.pendingValue - a.pendingValue);
  const capitalAtRisk = atRisk.reduce((sum, r) => sum + r.pendingValue, 0);
  const quantilePct = Math.round((1 - (rules.capital_risk_quantile ?? 0.75)) * 100);

  /* ---- 1.2 Vendor Concentration ---- */
  const byVendor = new Map<string, { name: string; value: number }>();
  tracker.forEach((r) => {
    const k = key(r.vendorCode || r.vendorName);
    const cur = byVendor.get(k) ?? { name: r.vendorName, value: 0 };
    cur.value += r.pendingValue;
    byVendor.set(k, cur);
  });
  const vendorValues = [...byVendor.values()].sort((a, b) => b.value - a.value);
  const totalOpenValue = vendorValues.reduce((s, v) => s + v.value, 0);
  const top3 = vendorValues.slice(0, 3);
  const top3Value = top3.reduce((s, v) => s + v.value, 0);
  const concentrationPct = totalOpenValue > 0 ? Math.round((top3Value / totalOpenValue) * 100) : 0;
  const concentrationAlert = rules.vendor_concentration_alert ?? 40;

  /* ---- 1.3 Capacity vs Demand ---- */
  const withCapacity = rollups.filter((r) => r.capacityPerMonth > 0);
  const over = withCapacity
    .filter((r) => r.utilizationPct > (rules.utilization_over_pct ?? 100))
    .sort((a, b) => b.utilizationPct - a.utilizationPct);
  const under = withCapacity
    .filter((r) => r.utilizationPct < (rules.utilization_under_pct ?? 70))
    .sort((a, b) => (b.capacityPerMonth - b.openQty) - (a.capacityPerMonth - a.openQty));

  /* ---- 1.9 Vendor Delivery Reliability (recent window) ---- */
  const windowDays = rules.reliability_window_days ?? 60;
  const cutoff = new Date(today.getTime() - windowDays * 86_400_000).toISOString().slice(0, 10);
  const recent = tracker.filter((r) => {
    const poDate = r.skuRows[0]?.po_date ?? r.skuRows[0]?.po_created_date;
    return poDate != null && poDate >= cutoff;
  });
  const relByVendor = new Map<string, { name: string; total: number; delayed: number }>();
  recent.forEach((r) => {
    const k = key(r.vendorCode || r.vendorName);
    const cur = relByVendor.get(k) ?? { name: r.vendorName, total: 0, delayed: 0 };
    cur.total += 1;
    if (r.delayDays > 0) cur.delayed += 1;
    relByVendor.set(k, cur);
  });
  const struggling = [...relByVendor.values()]
    .filter((v) => v.total >= 2 && v.delayed > 0)
    .map((v) => ({ ...v, pct: Math.round((v.delayed / v.total) * 100) }))
    .sort((a, b) => b.pct - a.pct || b.delayed - a.delayed)
    .slice(0, 4);

  /* ---- 1.6 trend prep ---- */
  const trend = extras?.tnaTrend ?? null;
  const trendData = (trend ?? []).map((s) => ({
    date: s.snapshot_date.slice(5), // MM-DD
    onTimePct: s.open_total > 0 ? Math.round((s.on_time / s.open_total) * 100) : 0,
    highRisk: s.high_risk,
    overdue: s.overdue,
  }));

  /* ---- 1.5 prep ---- */
  const realization = extras?.planRealization ?? null;
  const curMonth = realization?.[0] ?? null;
  const prevMonths = (realization ?? []).slice(1);

  /* ---- 1.7 prep ---- */
  const closure = extras?.closure ?? null;
  const closurePct =
    closure && closure.closedTotal > 0
      ? Math.round((closure.closedWithinSla / closure.closedTotal) * 100)
      : null;

  const cost = extras?.costVariance ?? null;
  const disc = extras?.discontinued ?? null;
  const gaps = extras?.stockoutGaps ?? null;

  return (
    <div className="ana-grid">
      {/* 1.1 Capital at Risk */}
      <AnaCard
        title="Capital at Risk"
        icon={AlertTriangle}
        tone={!tnaDataPresent ? 'neutral' : atRisk.length ? 'red' : 'green'}
        span={4}
        onClick={() => onTab('open-po')}
        info={`Open POs that are BOTH TNA High Risk (a critical-path stage past its planned date) AND in the top ${quantilePct}% of open POs by pending value — the delays that matter most in rupee terms, not every delay. Threshold editable in the Rules Master.`}
      >
        {!tnaDataPresent ? (
          <NoData text="TNA data not available yet — cannot assess risk." />
        ) : (
          <>
            <strong className="ana-value">{money.format(capitalAtRisk)}</strong>
            <small className="ana-note">
              {atRisk.length
                ? `${atRisk.length} high-risk PO(s) in the top ${quantilePct}% by value`
                : 'No high-value PO is currently TNA high-risk'}
            </small>
            {atRisk.length > 0 && (
              <ul className="ana-list">
                {atRisk.slice(0, 3).map((r) => (
                  <li key={r.key}>
                    <span className="mono">{r.poRef}</span>
                    <span className="ana-list-mid">{r.vendorName}</span>
                    <span className="ana-list-val">{money.format(r.pendingValue)}</span>
                  </li>
                ))}
                {atRisk.length > 3 && <li className="ana-more">+{atRisk.length - 3} more — open the High Risk lens</li>}
              </ul>
            )}
          </>
        )}
      </AnaCard>

      {/* 1.2 Vendor Concentration Risk */}
      <AnaCard
        title="Vendor Concentration"
        icon={Factory}
        tone={totalOpenValue === 0 ? 'neutral' : concentrationPct > concentrationAlert ? 'amber' : 'green'}
        span={4}
        onClick={() => onTab('vendors')}
        info={`Share of total open buying value held by the top 3 vendors. Above ${concentrationAlert}% (editable in the Rules Master) is flagged — over-reliance on a small vendor set is a supply-chain risk that should influence allocation.`}
      >
        {totalOpenValue === 0 ? (
          <NoData text="No open PO value to measure." />
        ) : (
          <>
            <strong className="ana-value">{concentrationPct}%</strong>
            <small className="ana-note">
              of {money.format(totalOpenValue)} open value sits with 3 of {vendorValues.length} vendors
              {concentrationPct > concentrationAlert ? ` — above the ${concentrationAlert}% alert line` : ''}
            </small>
            <ul className="ana-list">
              {top3.map((v) => (
                <li key={v.name}>
                  <span className="ana-list-mid">{v.name}</span>
                  <span className="ana-list-val">
                    {totalOpenValue > 0 ? Math.round((v.value / totalOpenValue) * 100) : 0}%
                  </span>
                </li>
              ))}
            </ul>
          </>
        )}
      </AnaCard>

      {/* 1.7 PO Closure Compliance */}
      <AnaCard
        title="PO Closure Compliance"
        icon={CheckCheck}
        tone={!closure ? 'neutral' : closure.openBeyondSla > 0 ? 'red' : 'green'}
        span={4}
        href="/po-closure"
        info={`Completed POs must be closed within ${closure?.slaDays ?? 15} days (SLA in the Rules Master). Shows the % of closed POs that met the SLA, and how many currently-open closures are already past it — the audit metric leadership wants enforced.`}
      >
        {!closure ? (
          <NoData text="Closure data not available." />
        ) : (
          <>
            <strong className="ana-value">{closurePct == null ? '—' : `${closurePct}%`}</strong>
            <small className="ana-note">
              {closure.closedTotal
                ? `${closure.closedWithinSla} of ${closure.closedTotal} closed within ${closure.slaDays}d`
                : 'No PO closed yet'}
            </small>
            <p className={closure.openBeyondSla ? 'ana-alert' : 'ana-ok'}>
              {closure.openBeyondSla
                ? `${closure.openBeyondSla} open closure(s) already past ${closure.slaDays} days`
                : 'No open closure past the SLA'}
            </p>
          </>
        )}
      </AnaCard>

      {/* 1.3 Capacity vs Demand */}
      <AnaCard
        title="Capacity vs Demand"
        icon={Scale}
        span={7}
        info={`Vendors over-committed (open quantity above ${rules.utilization_over_pct ?? 100}% of signed monthly capacity) vs. vendors with spare room (below ${rules.utilization_under_pct ?? 70}%). The allocation decision at PO time: who's overloaded, who can absorb more. Bands editable in the Rules Master; vendors with no signed capacity are excluded.`}
      >
        {!withCapacity.length ? (
          <NoData text="No vendor has a signed monthly capacity yet — nothing to compare." />
        ) : (
          <div className="ana-split">
            <div>
              <span className="ana-split-title ana-text-red">Over-committed · {over.length}</span>
              {over.length ? (
                <ul className="ana-list">
                  {over.slice(0, 4).map((v) => (
                    <li key={`${v.vendorCode}-${v.vendorBucket}`} className="clickable" onClick={() => onTab('vendors')}>
                      <span className="ana-list-mid">{v.vendorName}</span>
                      <span className="ana-list-val ana-text-red">{v.utilizationPct}%</span>
                    </li>
                  ))}
                  {over.length > 4 && <li className="ana-more">+{over.length - 4} more</li>}
                </ul>
              ) : (
                <p className="ana-ok">None over capacity</p>
              )}
            </div>
            <div>
              <span className="ana-split-title ana-text-green">Room to absorb · {under.length}</span>
              {under.length ? (
                <ul className="ana-list">
                  {under.slice(0, 4).map((v) => (
                    <li key={`${v.vendorCode}-${v.vendorBucket}`} className="clickable" onClick={() => onTab('vendors')}>
                      <span className="ana-list-mid">{v.vendorName}</span>
                      <span className="ana-list-val">
                        {v.utilizationPct}% · {fmt.format(Math.max(0, v.capacityPerMonth - v.openQty))} pcs free
                      </span>
                    </li>
                  ))}
                  {under.length > 4 && <li className="ana-more">+{under.length - 4} more</li>}
                </ul>
              ) : (
                <p className="ana-ok">No spare capacity anywhere</p>
              )}
            </div>
          </div>
        )}
      </AnaCard>

      {/* 1.4 Stockout Risk (No Coverage) */}
      <AnaCard
        title="Stockout Risk — No Coverage"
        icon={PackageX}
        tone={gaps == null ? 'neutral' : gaps.length ? 'red' : 'green'}
        span={5}
        onClick={() => onTab('urgent-replenish')}
        info="Variants with real, sustained demand (DOQ 45) but zero sellable stock AND no open PO covering the variant — genuinely uncovered demand, not low stock with a PO already in flight. Ranked by demand so the biggest gaps come first."
      >
        {gaps == null ? (
          <NoData text="Replenishment data not available." />
        ) : gaps.length ? (
          <>
            <small className="ana-note">{gaps.length === 8 ? '8+' : gaps.length} uncovered variant(s), highest demand first</small>
            <ul className="ana-list">
              {gaps.slice(0, 5).map((g) => (
                <li key={g.product_variant}>
                  <span className="mono">{g.product_variant}</span>
                  <span className="ana-list-mid">{g.product_name ?? g.product_code ?? ''}</span>
                  <span className="ana-list-val">DOQ {fmt.format(g.doq_45)}</span>
                </li>
              ))}
            </ul>
          </>
        ) : (
          <p className="ana-ok">Every high-demand variant has stock or an open PO covering it.</p>
        )}
      </AnaCard>

      {/* 1.5 Buying Plan Realization */}
      <AnaCard
        title="Buying Plan Realization"
        icon={Target}
        span={7}
        href="/buying-plan"
        info="This month's planned buying value (the FG buying plan, valued at approved standard costs) vs. the value actually issued as POs so far — per weave, with the prior two months for context. The standing leadership question: what did we plan vs. what is actually happening."
      >
        {!realization ? (
          <NoData text="Buying plan / PO actuals not available." />
        ) : !curMonth || !curMonth.buckets.length ? (
          <NoData text={`No buying plan found for ${new Date().toISOString().slice(0, 7)}.`} />
        ) : (
          <>
            {curMonth.buckets.map((b) => {
              const pct = b.planned > 0 ? Math.min(100, Math.round((b.actual / b.planned) * 100)) : null;
              return (
                <div key={b.category} className="ana-bar-row">
                  <span className="ana-bar-label">{b.category}</span>
                  <div className="ana-bar">
                    <div className="ana-bar-fill" style={{ width: `${pct ?? 0}%` }} />
                  </div>
                  <span className="ana-bar-val">
                    {money.format(b.actual)} / {money.format(b.planned)}{pct != null ? ` · ${pct}%` : ''}
                  </span>
                </div>
              );
            })}
            {prevMonths.length > 0 && (
              <small className="ana-note">
                Previous months:{' '}
                {prevMonths
                  .map((m) => {
                    const planned = m.buckets.reduce((s, b) => s + b.planned, 0);
                    const actual = m.buckets.reduce((s, b) => s + b.actual, 0);
                    const pct = planned > 0 ? Math.round((actual / planned) * 100) : null;
                    return `${m.month}: ${pct != null ? `${pct}%` : '—'}`;
                  })
                  .join(' · ')}
              </small>
            )}
          </>
        )}
      </AnaCard>

      {/* 1.6 TNA Compliance Trend */}
      <AnaCard
        title="TNA Compliance Trend"
        icon={TrendingUp}
        span={5}
        onClick={() => onTab('open-po')}
        info="Share of open POs On Track each day (neither TNA high-risk nor overdue), recorded daily from the same logic the tracker shows. A snapshot says today's state; the trend says whether execution is improving or degrading."
      >
        {trend == null ? (
          <NoData text="Snapshot data not available." />
        ) : trendData.length < 2 ? (
          <NoData
            text={`Trend data collection ${trendData.length ? `started ${trend[0].snapshot_date}` : 'starting today'} — one point per day; check back in a few days.`}
          />
        ) : (
          <div className="ana-chart">
            <ResponsiveContainer width="100%" height={120}>
              <AreaChart data={trendData} margin={{ top: 6, right: 6, left: -18, bottom: 0 }}>
                <defs>
                  <linearGradient id="anaOnTime" x1="0" y1="0" x2="0" y2="1">
                    <stop offset="0%" stopColor="#3d9e6b" stopOpacity={0.35} />
                    <stop offset="100%" stopColor="#3d9e6b" stopOpacity={0.02} />
                  </linearGradient>
                </defs>
                <CartesianGrid strokeDasharray="3 3" vertical={false} />
                <XAxis dataKey="date" fontSize={9} tickLine={false} />
                <YAxis domain={[0, 100]} fontSize={9} tickLine={false} />
                <Tooltip formatter={(v) => [`${v}%`, 'On Track']} />
                <Area type="monotone" dataKey="onTimePct" stroke="#3d9e6b" fill="url(#anaOnTime)" strokeWidth={2} />
              </AreaChart>
            </ResponsiveContainer>
            <small className="ana-note">
              Today: {trendData[trendData.length - 1].onTimePct}% on track ·{' '}
              {trendData[trendData.length - 1].highRisk} high-risk · {trendData[trendData.length - 1].overdue} overdue
            </small>
          </div>
        )}
      </AnaCard>

      {/* 1.8 Cost Variance Alert */}
      <AnaCard
        title="Cost Variance (This Month)"
        icon={IndianRupee}
        tone={cost == null ? 'neutral' : cost.count ? 'amber' : 'green'}
        span={4}
        href="/po-approval"
        info="POs approved/issued this month at a written rate above the product's approved standard cost — the approved-exception cases aggregated. Even sanctioned exceptions are margin erosion; this keeps the total visible instead of one-PO-at-a-time."
      >
        {cost == null ? (
          <NoData text="Standard-cost / PO approval data not available." />
        ) : cost.count ? (
          <>
            <strong className="ana-value">{money.format(cost.impact)}</strong>
            <small className="ana-note">{cost.count} PO(s) above standard this month</small>
            <ul className="ana-list">
              {cost.top.map((t) => (
                <li key={`${t.poRef}-${t.productCode}`}>
                  <span className="mono">{t.poRef}</span>
                  <span className="ana-list-mid">{t.productCode}</span>
                  <span className="ana-list-val">+{money.format(t.delta)}</span>
                </li>
              ))}
            </ul>
          </>
        ) : (
          <p className="ana-ok">No PO issued above standard cost this month.</p>
        )}
      </AnaCard>

      {/* 1.9 Vendor Delivery Reliability (recent) */}
      <AnaCard
        title={`Reliability — Last ${windowDays}d`}
        icon={Factory}
        tone={recent.length === 0 ? 'neutral' : struggling.length ? 'amber' : 'green'}
        span={4}
        onClick={() => onTab('vendors')}
        info={`Vendors ranked by delay rate over POs raised in the last ${windowDays} days (window editable in the Rules Master) — recency matters: an all-time-good vendor missing dates NOW should influence today's allocation. Vendors with fewer than 2 recent POs are excluded.`}
      >
        {recent.length === 0 ? (
          <NoData text={`No PO raised in the last ${windowDays} days.`} />
        ) : struggling.length ? (
          <>
            <small className="ana-note">Currently struggling ({recent.length} recent POs measured)</small>
            <ul className="ana-list">
              {struggling.map((v) => (
                <li key={v.name}>
                  <span className="ana-list-mid">{v.name}</span>
                  <span className="ana-list-val ana-text-red">
                    {v.pct}% · {v.delayed}/{v.total} late
                  </span>
                </li>
              ))}
            </ul>
          </>
        ) : (
          <p className="ana-ok">No vendor with repeated recent delays.</p>
        )}
      </AnaCard>

      {/* 1.10 Discontinued-but-Active */}
      <AnaCard
        title="Discontinued but Active"
        icon={Ban}
        tone={disc == null ? 'neutral' : disc.openPoCount || disc.planLineCount ? 'red' : 'green'}
        span={4}
        onClick={() => onTab('open-po')}
        info="Open POs or current buying-plan lines referencing a product the master marks Discontinued. Should always be zero — anything here is a data-integrity error nobody would think to go looking for."
      >
        {disc == null ? (
          <NoData text="Product master data not available." />
        ) : disc.openPoCount || disc.planLineCount ? (
          <>
            <strong className="ana-value">{disc.openPoCount + disc.planLineCount}</strong>
            <small className="ana-note">
              {disc.openPoCount ? `${disc.openPoCount} open PO line(s) · ${fmt.format(disc.openPoQty)} pcs` : ''}
              {disc.openPoCount && disc.planLineCount ? ' · ' : ''}
              {disc.planLineCount ? `${disc.planLineCount} buying-plan line(s)` : ''}
            </small>
            {disc.codes.length > 0 && (
              <p className="ana-alert">{disc.codes.slice(0, 6).join(', ')}{disc.codes.length > 6 ? '…' : ''}</p>
            )}
          </>
        ) : (
          <p className="ana-ok">Clean — nothing discontinued is being bought.</p>
        )}
      </AnaCard>
    </div>
  );
}
