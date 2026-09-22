'use client';

import Link from 'next/link';
import { HeaderInfo } from '@/components/header-info';
import { ArrowUpRight } from 'lucide-react';
import type { PpmPrep } from '@/lib/forms/types';

const fmt = new Intl.NumberFormat('en-IN', { maximumFractionDigits: 0 });
const money = new Intl.NumberFormat('en-IN', {
  style: 'currency',
  currency: 'INR',
  maximumFractionDigits: 0,
});
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
          sub={prep.oos ? `${fmt.format(prep.oos.oos)} of ${fmt.format(prep.oos.total)} variants with no stock on hand` : 'no replenishment data'}
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
          sub={
            prep.inward.planned > 0
              ? `${fmt.format(prep.inward.actual)} of ${fmt.format(prep.inward.planned)} pcs this month${
                  prep.inward.source === 'inward-plan' ? ' (Inward Plan sheet)' : ''
                }`
              : `${fmt.format(prep.inward.actual)} pcs received · nothing planned for this month`
          }
          href="/receivable-plan"
          tone="purple"
        />
        {/* These two used to say "View" and send people to another page for a number that can
            perfectly well be read here. The meeting should not need a second tab open. */}
        <Stat
          label="Buying plan vs issued"
          value={
            prep.planVsActual && prep.planVsActual.plannedQty > 0
              ? `${Math.round((prep.planVsActual.issuedQty / prep.planVsActual.plannedQty) * 100)}%`
              : '—'
          }
          sub={
            !prep.planVsActual
              ? 'no buying plan for this month'
              : prep.planVsActual.plannedQty > 0
                ? `${fmt.format(prep.planVsActual.issuedQty)} of ${fmt.format(prep.planVsActual.plannedQty)} pcs issued${
                    prep.planVsActual.valueFrozen ? '' : ' · plan has no frozen rates, so pieces not rupees'
                  }`
                : 'plan has no quantity yet'
          }
          href="/buying-plan"
          tone="purple"
        />
        <Stat
          label="Fabric surplus at closure"
          value={prep.surplus ? fmt.format(prep.surplus.qty) : '—'}
          sub={
            !prep.surplus || prep.surplus.closures === 0
              ? 'no surplus raised on any closed PO'
              : `mtr across ${fmt.format(prep.surplus.closures)} PO${prep.surplus.closures === 1 ? '' : 's'}${
                  prep.surplus.value > 0 ? ` · ${money.format(prep.surplus.value)}` : ''
                }`
          }
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
                <th>PO <HeaderInfo label="PO" /></th>
                <th>Vendor <HeaderInfo label="Vendor" /></th>
                <th>Status <HeaderInfo label="Status" /></th>
                <th>Why (current stage) <HeaderInfo label="Why (current stage)" /></th>
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
