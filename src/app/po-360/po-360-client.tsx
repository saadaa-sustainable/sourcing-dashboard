'use client';

import { useMemo, useState } from 'react';
import type { PoHubData, PoHubRow } from '@/lib/po-hub.server';
import type { InternalStatus } from '@/lib/types';

const inr = new Intl.NumberFormat('en-IN', { maximumFractionDigits: 0 });
const money = (v: number) => `₹${inr.format(Math.round(v))}`;

const STATUS_TONE: Record<InternalStatus, string> = {
  'On Track': 'ca-under',
  'High Risk': '',
  Overdue: 'ca-over',
};

type StatusFilter = 'All' | InternalStatus;

export function Po360Client({ data }: { data: PoHubData }) {
  const s = data.summary;
  const [filter, setFilter] = useState<StatusFilter>('All');

  const rows = useMemo(
    () => (filter === 'All' ? data.rows : data.rows.filter((r) => r.status === filter)),
    [data.rows, filter],
  );

  return (
    <>
      {/* Objective KPIs — the PO portfolio at a glance across every facet. */}
      <div className="ca-kpi-row">
        <div className="ca-kpi">
          <span className="ca-kpi-label">Open POs</span>
          <strong>{inr.format(s.openPos)}</strong>
          <small>{money(s.openValue)} open value</small>
        </div>
        <div className="ca-kpi">
          <span className="ca-kpi-label">Capital at risk</span>
          <strong className={s.atRiskValue > 0 ? 'ca-over' : ''}>{money(s.atRiskValue)}</strong>
          <small>{s.atRiskCount} high-risk / overdue POs</small>
        </div>
        <div className="ca-kpi">
          <span className="ca-kpi-label">TNA on-time</span>
          <strong className={s.tnaOnTimePct >= 80 ? 'ca-under' : s.tnaOnTimePct >= 60 ? '' : 'ca-over'}>
            {s.tnaOnTimePct}%
          </strong>
          <small>{s.onTrack} on track · {s.highRisk} risk · {s.overdue} overdue</small>
        </div>
        <div className="ca-kpi">
          <span className="ca-kpi-label">Cost variance · mo</span>
          <strong className={s.costVarianceCount > 0 ? 'ca-over' : ''}>{s.costVarianceCount}</strong>
          <small>{s.costVarianceImpact ? `${money(s.costVarianceImpact)} impact` : 'none above standard'}</small>
        </div>
        <div className="ca-kpi">
          <span className="ca-kpi-label">Closure within SLA</span>
          <strong className={s.closureWithinSlaPct == null ? '' : s.closureWithinSlaPct >= 80 ? 'ca-under' : 'ca-over'}>
            {s.closureWithinSlaPct == null ? '—' : `${s.closureWithinSlaPct}%`}
          </strong>
          <small>{s.closureSlaDays != null ? `${s.closureSlaDays}-day SLA` : 'no closures yet'}</small>
        </div>
        <div className="ca-kpi">
          <span className="ca-kpi-label">Issued this week</span>
          <strong>{inr.format(s.issuedThisWeek)}</strong>
          <small>
            {s.issuedDeltaPct == null ? 'vs last week' : `${s.issuedDeltaPct > 0 ? '+' : ''}${s.issuedDeltaPct}% WoW`}
            {' · '}{s.pendingApprovalCount} pending approval
          </small>
        </div>
      </div>

      <div className="ca-dim-tabs">
        <span className="wf-subtle">Status</span>
        {(['All', 'Overdue', 'High Risk', 'On Track'] as const).map((f) => (
          <button key={f} className={filter === f ? 'active' : ''} onClick={() => setFilter(f)}>
            {f}
          </button>
        ))}
        <span className="wf-subtle">{inr.format(rows.length)} of {inr.format(data.rows.length)} open POs</span>
      </div>

      <div className="table-panel wf-grid-panel">
        <div className="table-scroll">
          <table className="wf-grid">
            <thead>
              <tr>
                <th>PO</th>
                <th>Product</th>
                <th>Vendor</th>
                <th>Type</th>
                <th className="num">Open value</th>
                <th>EDD</th>
                <th className="num">Delay</th>
                <th>Status · blocking stage</th>
                <th className="num">Cost Δ/unit</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <PoRow key={`${r.poRef}-${r.productCode}-${r.edd ?? ''}`} r={r} />
              ))}
              {!rows.length && (
                <tr><td colSpan={9} className="wf-empty-cell">No open POs in this status.</td></tr>
              )}
            </tbody>
          </table>
        </div>
      </div>
      <p className="wf-subtle" style={{ marginTop: 10 }}>
        One PO objective, one view — financial risk (capital at risk + cost variance), timeline
        compliance (TNA), closure compliance and issuance flow, anchored on the PO. Reuses the same
        sources as the individual dashboard cards (tracker + analytics extras), consolidated per the
        DAM one-pager principle.
      </p>
    </>
  );
}

function PoRow({ r }: { r: PoHubRow }) {
  return (
    <tr>
      <td><strong>{r.poRef || '—'}</strong></td>
      <td>{r.productCode}</td>
      <td>{r.vendorName}</td>
      <td>{(r.poType || '—').toUpperCase()}</td>
      <td className="num">{money(r.pendingValue)}</td>
      <td>{r.edd ?? '—'}</td>
      <td className={`num ${r.delayDays > 0 ? 'ca-over' : ''}`}>{r.delayDays > 0 ? `${r.delayDays}d` : '—'}</td>
      <td>
        <span className={STATUS_TONE[r.status]} style={{ fontWeight: 700 }}>{r.status}</span>
        {r.status !== 'On Track' && r.stage ? <small className="wf-subtle"> · {r.stage}</small> : null}
      </td>
      <td className={`num ${r.costVarianceDelta ? 'ca-over' : ''}`}>
        {r.costVarianceDelta ? `+${inr.format(Math.round(r.costVarianceDelta))}` : '—'}
      </td>
    </tr>
  );
}
