'use client';

/**
 * Cross-tab decision cards for the main Dashboard tab — the "so what" layer
 * above the descriptive KPIs. Each card combines data from two or more modules
 * and answers "what needs attention" / "what decision does this support", with
 * named items and a click-through to the underlying detail. Thresholds come
 * from the editable Rules Master (sd_analytics_rule), not hardcoded.
 *
 * PROOF BATCH: 1.1 Capital at Risk + 1.3 Capacity vs Demand. The remaining
 * cards follow once the visual direction is confirmed.
 */

import { useMemo } from 'react';
import { AlertTriangle, ArrowUpRight, Scale } from 'lucide-react';
import { buildTrackerRows, buildVendorRollups, istToday } from '@/lib/business-logic';
import { InfoDot } from './info-dot';
import type { DashboardData } from '@/lib/types';
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

export function AnalyticsCards({
  data,
  rules,
  onTab,
}: {
  data: DashboardData;
  rules: Record<string, number>;
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

  /* ---- 1.1 Capital at Risk: High Risk ∩ top value band ---- */
  const tnaDataPresent = data.tnaRecords.length > 0;
  const values = tracker.map((r) => r.pendingValue).filter((v) => v > 0).sort((a, b) => a - b);
  const valueThreshold = quantile(values, rules.capital_risk_quantile ?? 0.75);
  const atRisk = tracker
    .filter((r) => r.highRisk && r.pendingValue >= valueThreshold)
    .sort((a, b) => b.pendingValue - a.pendingValue);
  const capitalAtRisk = atRisk.reduce((sum, r) => sum + r.pendingValue, 0);
  const quantilePct = Math.round((1 - (rules.capital_risk_quantile ?? 0.75)) * 100);

  /* ---- 1.3 Capacity vs Demand: over-committed vs spare capacity ---- */
  const withCapacity = rollups.filter((r) => r.capacityPerMonth > 0);
  const over = withCapacity
    .filter((r) => r.utilizationPct > (rules.utilization_over_pct ?? 100))
    .sort((a, b) => b.utilizationPct - a.utilizationPct);
  const under = withCapacity
    .filter((r) => r.utilizationPct < (rules.utilization_under_pct ?? 70))
    .sort((a, b) => (b.capacityPerMonth - b.openQty) - (a.capacityPerMonth - a.openQty));
  const capacityDataPresent = withCapacity.length > 0;

  return (
    <div className="ana-grid">
      {/* 1.1 Capital at Risk */}
      <section
        className={`ana-card ${atRisk.length ? 'ana-red' : 'ana-green'} clickable`}
        role="button"
        tabIndex={0}
        onClick={() => onTab('open-po')}
        onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onTab('open-po'); } }}
      >
        <div className="ana-head">
          <span className="ana-head-left">
            <span className="ana-icon"><AlertTriangle size={13} strokeWidth={2} /></span>
            <span className="ana-label">Capital at Risk</span>
          </span>
          <InfoDot
            text={`Open POs that are BOTH TNA High Risk (a critical-path stage past its planned date) AND in the top ${quantilePct}% of open POs by pending value — the delays that matter most in rupee terms, not every delay. Threshold is editable in the Rules Master.`}
            label="About Capital at Risk"
          />
        </div>
        {!tnaDataPresent ? (
          <p className="ana-nodata">TNA data not available yet — cannot assess risk.</p>
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
                {atRisk.length > 3 && (
                  <li className="ana-more">+{atRisk.length - 3} more — open the High Risk lens</li>
                )}
              </ul>
            )}
          </>
        )}
        <ArrowUpRight className="ana-go" size={15} />
      </section>

      {/* 1.3 Capacity vs Demand Mismatch */}
      <section className="ana-card ana-wide">
        <div className="ana-head">
          <span className="ana-head-left">
            <span className="ana-icon"><Scale size={13} strokeWidth={2} /></span>
            <span className="ana-label">Capacity vs Demand</span>
          </span>
          <InfoDot
            text={`Vendors over-committed (open quantity above ${rules.utilization_over_pct ?? 100}% of signed monthly capacity) vs. vendors with spare room (below ${rules.utilization_under_pct ?? 70}%). This is the allocation decision at PO time: who's overloaded, who can absorb more. Bands are editable in the Rules Master. Vendors with no signed capacity are excluded (no basis to judge).`}
            label="About Capacity vs Demand"
          />
        </div>
        {!capacityDataPresent ? (
          <p className="ana-nodata">No vendor has a signed monthly capacity yet — nothing to compare.</p>
        ) : (
          <div className="ana-split">
            <div>
              <span className="ana-split-title ana-text-red">
                Over-committed · {over.length}
              </span>
              {over.length ? (
                <ul className="ana-list">
                  {over.slice(0, 4).map((v) => (
                    <li
                      key={`${v.vendorCode}-${v.vendorBucket}`}
                      className="clickable"
                      onClick={() => onTab('vendors')}
                    >
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
              <span className="ana-split-title ana-text-green">
                Room to absorb · {under.length}
              </span>
              {under.length ? (
                <ul className="ana-list">
                  {under.slice(0, 4).map((v) => (
                    <li
                      key={`${v.vendorCode}-${v.vendorBucket}`}
                      className="clickable"
                      onClick={() => onTab('vendors')}
                    >
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
      </section>
    </div>
  );
}
