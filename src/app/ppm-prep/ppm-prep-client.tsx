'use client';

import Link from 'next/link';
import { ArrowUpRight } from 'lucide-react';
import type { PpmPrep } from '@/lib/forms/types';

const fmt = new Intl.NumberFormat('en-IN', { maximumFractionDigits: 0 });
const monthLabel = (m: string) =>
  new Date(`${m.slice(0, 10)}T00:00:00Z`).toLocaleDateString('en-IN', {
    month: 'long',
    year: 'numeric',
    timeZone: 'UTC',
  });

function Stat({
  label,
  value,
  sub,
  href,
  tone = 'purple',
}: {
  label: string;
  value: string;
  sub?: string;
  href: string;
  tone?: string;
}) {
  return (
    <Link href={href} className={`metric-card tone-${tone} clickable`} style={{ position: 'relative' }}>
      <span className="metric-label">{label}</span>
      <strong>{value}</strong>
      {sub && <small>{sub}</small>}
      <ArrowUpRight className="metric-action" size={15} />
    </Link>
  );
}

export function PpmPrepClient({ prep }: { prep: PpmPrep }) {
  const inwardPct =
    prep.inward.planned > 0 ? Math.round((prep.inward.actual / prep.inward.planned) * 100) : null;

  return (
    <>
      <p className="wf-subtle">
        Week of {new Date(prep.weekStart).toLocaleDateString('en-IN')} · plan month{' '}
        {monthLabel(prep.planMonth)}.
      </p>

      <div className="metric-grid compact">
        <Stat
          label="Out of stock"
          value={prep.oos ? `${prep.oos.pct}%` : '—'}
          sub={prep.oos ? `${fmt.format(prep.oos.oos)} of ${fmt.format(prep.oos.total)} SKUs` : 'no replenishment data'}
          href="/oos-calculation"
          tone="red"
        />
        <Stat
          label="POs pending approval"
          value={fmt.format(prep.pendingApproval)}
          sub="cost + standard, awaiting sign-off"
          href="/approvals"
          tone="orange"
        />
        <Stat
          label="POs pending issuance"
          value={fmt.format(prep.pendingIssuance.count)}
          sub={`${fmt.format(prep.pendingIssuance.qty)} pcs approved, not issued`}
          href="/po-approval"
          tone="amber"
        />
        <Stat
          label="Approvals this week"
          value={fmt.format(prep.approvalsThisWeek)}
          sub="POs approved since Monday"
          href="/po-approval"
          tone="teal"
        />
        <Stat
          label="Inward — planned vs actual"
          value={inwardPct == null ? '—' : `${inwardPct}%`}
          sub={`${fmt.format(prep.inward.actual)} of ${fmt.format(prep.inward.planned)} pcs (this month)`}
          href="/arrivals"
          tone="purple"
        />
        <Stat
          label="Plan vs actual"
          value="View"
          sub="Buying Plan Realization (main dashboard)"
          href="/"
          tone="purple"
        />
        <Stat
          label="Surplus approvals"
          value="View"
          sub="PO Closure surplus"
          href="/po-closure"
          tone="teal"
        />
      </div>

      <section className="table-panel" style={{ marginTop: 18 }}>
        <div className="table-meta">
          <h3>PO audit — High Risk &amp; Overdue</h3>
          <span>
            {fmt.format(prep.highRisk.count)} high risk · {fmt.format(prep.highRisk.overdue)} overdue
          </span>
        </div>
        <div className="table-scroll">
          <table className="wide-table">
            <thead>
              <tr>
                <th>PO</th>
                <th>Vendor</th>
                <th>Status</th>
                <th>Why (current stage)</th>
              </tr>
            </thead>
            <tbody>
              {prep.highRisk.top.map((r) => (
                <tr key={`${r.poRef}-${r.stage}`}>
                  <td className="mono">{r.poRef}</td>
                  <td>{r.vendor}</td>
                  <td>
                    <span className={`badge ${r.status === 'Overdue' ? 'danger' : 'warn'}`}>
                      {r.status}
                    </span>
                  </td>
                  <td>{r.stage}</td>
                </tr>
              ))}
              {!prep.highRisk.top.length && (
                <tr>
                  <td colSpan={4} className="wf-empty-cell">
                    No high-risk or overdue open POs — nothing to flag this week.
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
        <p className="wf-subtle" style={{ padding: '8px 12px' }}>
          Full audit on the{' '}
          <Link href="/?tab=open-po">Open PO Tracker</Link>.
        </p>
      </section>
    </>
  );
}
