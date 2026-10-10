import Link from 'next/link';
import type { ReactNode } from 'react';
import { addMonths, isPlanFrozen, monthLabel, type PlanCompliance } from '@/lib/forms/approval';

export type PlanTrackType = 'fg' | 'material' | 'analysis';

/** One month's plan status on each track (null = no plan row yet). */
export type PlanMonthStatus = { month: string; fg: string | null; material: string | null };

type Tone = 'ok' | 'warn' | 'crit' | 'info' | '';

/**
 * A plan status in words, for the badge (`text`) and the compact spots (`short`: tab dots,
 * the month list). A month that is over says how it ENDED, so an unfinished approval reads
 * as pending at month end rather than as still in progress.
 */
export function planStatusWord(status: string | null, closed: boolean): { tone: Tone; text: string; short: string } {
  switch (status) {
    case 'approved':
      return { tone: 'ok', text: 'Approved', short: 'Approved' };
    case 'submitted':
      return closed
        ? { tone: 'crit', text: 'Approval pending at month end', short: 'Pending at month end' }
        : { tone: 'warn', text: 'Awaiting approval', short: 'With approver' };
    case 'pending_l2':
      return closed
        ? { tone: 'crit', text: 'Approval pending at month end', short: 'Pending at month end' }
        : { tone: 'warn', text: 'Awaiting second approval', short: 'With 2nd approver' };
    case 'rework':
      return closed
        ? { tone: 'crit', text: 'Rework at month end', short: 'Rework at month end' }
        : { tone: 'crit', text: 'Sent for rework', short: 'Rework' };
    case 'rejected':
      return { tone: 'crit', text: 'Rejected', short: 'Rejected' };
    case 'draft':
      return closed
        ? { tone: 'crit', text: 'Not submitted', short: 'Not submitted' }
        : { tone: 'info', text: 'Draft', short: 'Draft' };
    default:
      return closed
        ? { tone: 'crit', text: 'Not submitted', short: 'Not submitted' }
        : { tone: '', text: 'Not started', short: 'Not started' };
  }
}

const dShort = (iso: string) =>
  new Date(iso).toLocaleDateString('en-IN', { day: 'numeric', month: 'short', timeZone: 'Asia/Kolkata' });

/** The day the plan freezes: the last day of its month. */
export function planFreezeDate(planMonth: string): string {
  return new Date(Date.parse(addMonths(planMonth, 1)) - 86_400_000).toISOString();
}

/** The approval-deadline fact for the header line; red only when it was missed. */
export function deadlineFact(c: PlanCompliance): ReactNode {
  const missed = c.status === 'breach_approval' || c.status === 'breach_submission';
  const title =
    c.status === 'breach_submission'
      ? 'The plan was not submitted by the deadline'
      : c.status === 'breach_approval'
        ? 'Submitted in time, but no approver decision by the deadline'
        : c.status === 'on_time'
          ? 'An approver acted by the deadline'
          : 'An approver must approve, reject or send for rework by this date';
  return (
    <span key="deadline" className={missed ? 'is-miss' : c.status === 'on_time' ? 'is-met' : undefined} title={title}>
      Approval deadline <b>{dShort(c.deadline)}</b>
      {missed ? ` · missed${c.daysLate ? ` by ${c.daysLate} day${c.daysLate === 1 ? '' : 's'}` : ''}` : c.status === 'on_time' ? ' · met' : ''}
    </span>
  );
}

/** Submitted / with which approver / decided — the plan's own facts, in order. */
export function planFacts(
  planMonth: string,
  plan: { status: string; submitted_at: string | null; decided_at: string | null } | null,
  compliance?: PlanCompliance,
): ReactNode[] {
  const out: ReactNode[] = [];
  const status = plan?.status ?? null;
  if (plan?.submitted_at) {
    out.push(
      <span key="sub">
        Submitted <b>{dShort(plan.submitted_at)}</b>
        {compliance?.status === 'breach_submission' ? ' · late' : ''}
      </span>,
    );
  } else {
    out.push(<span key="sub">Not submitted yet</span>);
  }
  if (status === 'pending_l2') out.push(<span key="stage">With the <b>second approver</b></span>);
  if (status === 'submitted') out.push(<span key="stage">With the <b>first approver</b></span>);
  if (plan?.decided_at && (status === 'approved' || status === 'rejected' || status === 'rework')) {
    out.push(
      <span key="dec">
        {status === 'approved' ? 'Approved' : status === 'rejected' ? 'Rejected' : 'Sent back'} <b>{dShort(plan.decided_at)}</b>
      </span>,
    );
  }
  if (compliance) out.push(deadlineFact(compliance));
  out.push(
    <span key="freeze">
      {isPlanFrozen(planMonth) ? 'Frozen' : 'Freezes'} <b>{dShort(planFreezeDate(planMonth))}</b>
    </span>,
  );
  return out;
}

const TRACKS: [PlanTrackType, string][] = [
  ['fg', 'Finished goods'],
  ['material', 'Fabric / Material'],
  ['analysis', 'Analysis'],
];

/**
 * The one header every Buying Plan tab uses: "All months" link, the month as the heading with
 * this track's status, one quiet facts line, the month picker (‹ Month ▾ ›, its list showing
 * both tracks' statuses per month) and the tab's actions; then the tabs, each with its own
 * status dot, View / Input on the right, and the Input-only bar under them.
 * No hooks: the month list is a <details>, so server and client pages can both render it.
 */
export function PlanHeader({
  planMonth,
  planType,
  months,
  status,
  badges,
  facts,
  actions,
  modeControl,
  inputBar,
}: {
  planMonth: string;
  planType: PlanTrackType;
  months: PlanMonthStatus[];
  /** The heading badge; defaults to this track's status from `months`. */
  status?: { tone: Tone; text: string };
  /** Extra badges after the status (e.g. line-review progress). */
  badges?: ReactNode;
  facts: ReactNode[];
  actions?: ReactNode;
  /** View / Input switch, shown on the tabs row (open months only). */
  modeControl?: ReactNode;
  /** Input-only actions (Template, Import CSV, Save draft), shown under the tabs. */
  inputBar?: ReactNode;
}) {
  const closed = isPlanFrozen(planMonth);
  const list = (months.some((m) => m.month === planMonth) ? [...months] : [...months, { month: planMonth, fg: null, material: null }])
    .sort((a, b) => a.month.localeCompare(b.month));
  const at = list.findIndex((m) => m.month === planMonth);
  const me = list[at];
  const prev = at > 0 ? list[at - 1] : undefined;
  const next = at >= 0 && at < list.length - 1 ? list[at + 1] : undefined;
  const href = (month: string, type: PlanTrackType = planType) => `/buying-plan?month=${month}&type=${type}`;
  const badge =
    status ?? (planType === 'analysis' ? { tone: (closed ? '' : 'info') as Tone, text: closed ? 'Month closed' : 'Month open' } : planStatusWord(me?.[planType] ?? null, closed));
  const shortMonth = (m: string) => new Date(`${m}T00:00:00Z`).toLocaleDateString('en-IN', { month: 'short', year: 'numeric', timeZone: 'UTC' });

  return (
    <div className="bph">
      <Link className="bph-crumb" href="/buying-plan">
        <svg width="14" height="14" viewBox="0 0 16 16" aria-hidden="true"><path d="M10 3L5 8l5 5" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" /></svg>
        All months
      </Link>
      <div className="bph-row">
        <div className="bph-main">
          <div className="bph-title">
            <h2>{monthLabel(planMonth)}</h2>
            <span className={`bph-badge ${badge.tone}`}><i />{badge.text}</span>
            {closed && planType !== 'analysis' && <span className="bph-badge" title="The month is over — the plan is shown as it was entered">View only</span>}
            {badges}
          </div>
          <div className="bph-facts">{facts}</div>
        </div>
        <div className="bph-actions">
          <div className="bph-picker">
            {prev ? (
              <Link className="bph-arw" href={href(prev.month)} aria-label="Previous month" title={monthLabel(prev.month)}>‹</Link>
            ) : (
              <span className="bph-arw is-off" aria-hidden="true">‹</span>
            )}
            <details className="bph-menu">
              <summary>
                {shortMonth(planMonth)}
                <svg width="12" height="12" viewBox="0 0 16 16" aria-hidden="true"><path d="M4 6l4 4 4-4" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" /></svg>
              </summary>
              <div className="bph-menu-list" role="menu">
                {[...list].reverse().map((m) => {
                  const mClosed = isPlanFrozen(m.month);
                  const f = planStatusWord(m.fg, mClosed);
                  const t = planStatusWord(m.material, mClosed);
                  return (
                    <Link key={m.month} role="menuitem" href={href(m.month)} className={m.month === planMonth ? 'is-on' : undefined}>
                      <b>{monthLabel(m.month)}</b>
                      <small>{mClosed ? 'Closed' : 'Open'}</small>
                      <span className="bph-menu-track"><i className={`bph-dot ${f.tone}`} />FG · {f.short}</span>
                      <span className="bph-menu-track"><i className={`bph-dot ${t.tone}`} />Material · {t.short}</span>
                    </Link>
                  );
                })}
                <Link role="menuitem" href="/buying-plan" className="bph-menu-board">Open the month board</Link>
              </div>
            </details>
            {next ? (
              <Link className="bph-arw" href={href(next.month)} aria-label="Next month" title={monthLabel(next.month)}>›</Link>
            ) : (
              <span className="bph-arw is-off" aria-hidden="true">›</span>
            )}
          </div>
          {actions}
        </div>
      </div>
      <div className="bph-tabsrow">
        <nav className="bph-tabs" aria-label="Buying plan track">
          {TRACKS.map(([type, label]) => {
            const word = type === 'analysis' ? null : planStatusWord(me?.[type] ?? null, closed);
            return (
              <Link key={type} href={href(planMonth, type)} className={`bph-tab${planType === type ? ' is-on' : ''}`} aria-current={planType === type ? 'page' : undefined}>
                {word && <i className={`bph-dot ${word.tone}`} />}
                {label}
                {word && <small>{word.short}</small>}
              </Link>
            );
          })}
        </nav>
        {modeControl}
      </div>
      {inputBar && <div className="bph-inputbar">{inputBar}</div>}
    </div>
  );
}
