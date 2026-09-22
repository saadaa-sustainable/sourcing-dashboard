'use client';

import { DeboardedPill } from '@/components/forms/deboarded-pill';
import { useMemo, useState } from 'react';
import { InfoDot } from '@/components/info-dot';
import type { VendorHubData, VendorHubRow } from '@/lib/vendor-hub.server';

const inr = new Intl.NumberFormat('en-IN', { maximumFractionDigits: 0 });
const money = (v: number) => `₹${inr.format(Math.round(v))}`;
const pct = (v: number | null) => (v == null ? '—' : `${Math.round(v)}%`);

type SortKey = 'openValue' | 'delayPct' | 'otifPct' | 'utilizationPct';

/** Delivery/OTIF tone: green good, amber watch, red poor. */
function otifTone(v: number | null): string {
  if (v == null) return '';
  if (v >= 90) return 'ca-under'; // green
  if (v >= 75) return '';
  return 'ca-over'; // red
}
function delayTone(v: number): string {
  if (v <= 0) return 'ca-under';
  if (v <= 20) return '';
  return 'ca-over';
}

export function Vendor360Client({ data }: { data: VendorHubData }) {
  const [weave, setWeave] = useState<'All' | 'Woven' | 'Knit'>('All');
  const [sort, setSort] = useState<SortKey>('openValue');

  const rows = useMemo(() => {
    const filtered = weave === 'All' ? data.rows : data.rows.filter((r) => r.weave === weave);
    return [...filtered].sort((a, b) => {
      const av = a[sort] ?? -1;
      const bv = b[sort] ?? -1;
      return (bv as number) - (av as number);
    });
  }, [data.rows, weave, sort]);

  const quarters = Math.round(data.windowDays / 90);

  return (
    <>
      {/* Objective KPIs — the Vendor picture at a glance. */}
      <div className="ca-kpi-row">
        <div className="ca-kpi">
          <span className="ca-kpi-label">Active vendors <InfoDot text={"WHAT: how many vendors currently have work from SAADAA.\n\nHOW: distinct vendors with at least one open (Approved) PO.\n\nUSE: the vendors whose rows appear below. Active vendors with nothing open are on the Main Dashboard's Vendor Performance tab."} /></span>
          <strong>{data.summary.vendors}</strong>
          <small>with open work</small>
        </div>
        <div className="ca-kpi">
          <span className="ca-kpi-label">Top-3 concentration <InfoDot text={"WHAT: how much of the open value sits with just three vendors.\n\nHOW: open value of the three biggest vendors ÷ total open value. Example: ₹2.1 Cr of ₹3.5 Cr → 60%.\n\nUSE: above 40% (editable in Rules Master) one vendor's problem becomes SAADAA's problem. Spread the next orders."} /></span>
          <strong className={data.summary.top3ConcentrationPct > 40 ? 'ca-over' : ''}>
            {data.summary.top3ConcentrationPct}%
          </strong>
          <small>of open buying value</small>
        </div>
        <div className="ca-kpi">
          <span className="ca-kpi-label">Avg OTIF · {quarters}q <InfoDot text={"WHAT: how often vendors deliver on time AND in full, overall.\n\nHOW: per vendor, POs that were both on time (by the committed date, else the PO's expected date) and in full (received ≥ ordered) ÷ its rated POs, over the recent window; averaged across vendors weighted by how many POs each had. A vendor with 20 POs counts more than one with 2.\n\nUSE: the one-number vendor scorecard. Per-vendor detail is on Vendor OTIF."} /></span>
          <strong className={otifTone(data.summary.avgOtifPct)}>{pct(data.summary.avgOtifPct)}</strong>
          <small>weighted by rated POs</small>
        </div>
        <div className="ca-kpi">
          <span className="ca-kpi-label">Worst delay <InfoDot text={"WHAT: the vendor that is currently late on the largest share of its work.\n\nHOW: per vendor, open POs past their expected delivery date ÷ its open POs; the highest is shown. Example: 6 of 8 late → 75%.\n\nUSE: the first vendor conversation this week."} /></span>
          <strong className="ca-over">{data.summary.worstDelay ? `${Math.round(data.summary.worstDelay.delayPct)}%` : '—'}</strong>
          <small>{data.summary.worstDelay?.vendorName ?? 'none'}</small>
        </div>
        <div className="ca-kpi">
          <span className="ca-kpi-label">Over capacity <InfoDot text={"WHAT: how many vendors have more on order than they can make in a month.\n\nHOW: vendors where open-PO pieces ÷ monthly capacity is above 100% (capacity = karigars × daily output × working days, from Vendor Capacity).\n\nUSE: each of these will be late on something — decide which PO matters most rather than letting the vendor decide."} /></span>
          <strong className={data.summary.overUtilised > 0 ? 'ca-over' : ''}>{data.summary.overUtilised}</strong>
          <small>vendors &gt; 100% util</small>
        </div>
      </div>

      <div className="ca-dim-tabs">
        <span className="wf-subtle">Fabric pool</span>
        {(['All', 'Woven', 'Knit'] as const).map((w) => (
          <button key={w} className={weave === w ? 'active' : ''} onClick={() => setWeave(w)}>{w}</button>
        ))}
        <span className="wf-subtle" style={{ marginLeft: 12 }}>Sort by</span>
        {([['openValue', 'Open value'], ['delayPct', 'Delay %'], ['otifPct', 'OTIF'], ['utilizationPct', 'Utilisation']] as [SortKey, string][]).map(
          ([k, label]) => (
            <button key={k} className={sort === k ? 'active' : ''} onClick={() => setSort(k)}>{label}</button>
          ),
        )}
      </div>

      <div className="table-panel wf-grid-panel">
        <div className="table-scroll">
          <table className="wf-grid">
            <thead>
              <tr>
                <th>Vendor</th>
                <th>Weave</th>
                <th className="num">Open value</th>
                <th className="num">Share</th>
                <th className="num">Open POs</th>
                <th className="num">Delay %</th>
                <th className="num">OTIF</th>
                <th className="num">On-time</th>
                <th className="num">Fill</th>
                <th className="num">Capacity/mo</th>
                <th className="num">Utilisation</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <VendorRow key={`${r.vendorCode || r.vendorName}|${r.weave}`} r={r} />
              ))}
              {!rows.length && (
                <tr><td colSpan={11} className="wf-empty-cell">No vendors with open work in this pool.</td></tr>
              )}
            </tbody>
          </table>
        </div>
      </div>
      <p className="wf-subtle" style={{ marginTop: 10 }}>
        One Vendor objective, one view — concentration, delivery reliability, capacity and OTIF
        scoring anchored on the vendor. Reuses the same sources as the individual dashboard cards
        (vendor rollups + OTIF), consolidated per the DAM one-pager principle.
      </p>
    </>
  );
}

function VendorRow({ r }: { r: VendorHubRow }) {
  return (
    <tr>
      <td>
        <strong>{r.vendorName}</strong>
        {r.vendorCode ? <small className="wf-subtle" style={{ display: 'block' }}>{r.vendorCode}</small> : null}
        <DeboardedPill flag={r.deboarded} />
      </td>
      <td>{r.weave}</td>
      <td className="num">{money(r.openValue)}</td>
      <td className="num">{Math.round(r.sharePct)}%</td>
      <td className="num">{r.openPoCount}</td>
      <td className={`num ${delayTone(r.delayPct)}`}>{Math.round(r.delayPct)}%</td>
      <td className={`num ${otifTone(r.otifPct)}`}>{pct(r.otifPct)}</td>
      <td className="num">{pct(r.onTimePct)}</td>
      <td className="num">{pct(r.fillPct)}</td>
      <td className="num">{r.capacityPerMonth ? inr.format(r.capacityPerMonth) : '—'}</td>
      <td className={`num ${r.utilizationPct > 100 ? 'ca-over' : ''}`}>{r.capacityPerMonth ? `${Math.round(r.utilizationPct)}%` : '—'}</td>
    </tr>
  );
}
