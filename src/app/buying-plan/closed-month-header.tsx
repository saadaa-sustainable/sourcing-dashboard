'use client';

import type { Ref } from 'react';
import { Download, Eye } from 'lucide-react';
import { addMonths, monthLabel, type PlanCompliance } from '@/lib/forms/approval';
import type { SdStatus } from '@/lib/forms/types';

const dShort = (iso: string) =>
  new Date(iso).toLocaleDateString('en-IN', { day: 'numeric', month: 'short', timeZone: 'Asia/Kolkata' });

/** How the plan ended the month, in one word-pair. */
function outcome(status: SdStatus): { text: string; tone: 'green' | 'red' | 'gray' } {
  switch (status) {
    case 'approved':
      return { text: 'Approved', tone: 'green' };
    case 'submitted':
    case 'pending_l2':
      return { text: 'Never approved', tone: 'red' };
    case 'rework':
      return { text: 'Left in rework', tone: 'red' };
    case 'rejected':
      return { text: 'Rejected', tone: 'red' };
    default:
      return { text: 'Never submitted', tone: 'gray' };
  }
}

/**
 * Header for a month that is over (view only): one card with the outcome, the dates that
 * explain it, the month picker and Export. Replaces the live page bar, deadline chip,
 * line-review progress and the view-only notice on past months.
 */
export function ClosedMonthHeader({
  planMonth,
  status,
  submittedAt,
  decisionAt,
  compliance,
  monthHref,
  onExport,
  exportDisabled,
  chipRef,
}: {
  planMonth: string;
  status: SdStatus;
  submittedAt: string | null;
  decisionAt: string | null;
  /** Approval-deadline check; omitted on tracks without a deadline. */
  compliance?: PlanCompliance;
  monthHref: (month: string) => string;
  onExport: () => void;
  exportDisabled?: boolean;
  chipRef?: Ref<HTMLSpanElement>;
}) {
  const o = outcome(status);
  // The plan freezes on the last day of its month.
  const frozenOn = new Date(Date.parse(addMonths(planMonth, 1)) - 86_400_000).toISOString();
  const lateSubmit = compliance?.status === 'breach_submission';
  const stage = status === 'pending_l2' ? 'second approver' : status === 'submitted' ? 'first approver' : null;
  const deadlineMet = compliance?.status === 'on_time';

  return (
    <div className="bp-card bp-closed">
      <div className="bp-closed-main">
        <h2>
          {monthLabel(planMonth)} · closed
          <span className={`bp-badge ${o.tone}`}>{o.text}</span>
          <span className="bp-badge gray" ref={chipRef} title="The month is over — this plan is shown as it was entered">
            <Eye size={12} aria-hidden="true" /> View only
          </span>
        </h2>
        <div className="bp-closed-facts">
          {submittedAt ? (
            <span>
              Submitted <b>{dShort(submittedAt)}</b>
              {compliance ? (lateSubmit ? ' · late' : ' · on time') : ''}
            </span>
          ) : (
            <span>Never submitted</span>
          )}
          {stage && (
            <span>
              Last stage <b>{stage}</b>
            </span>
          )}
          {decisionAt && status !== 'submitted' && status !== 'pending_l2' && (
            <span>
              Decided <b>{dShort(decisionAt)}</b>
            </span>
          )}
          {compliance && (
            <span>
              Approval deadline <b>{dShort(compliance.deadline)}</b> · {deadlineMet ? 'met' : 'missed'}
            </span>
          )}
          <span>
            Frozen <b>{dShort(frozenOn)}</b>
          </span>
        </div>
      </div>
      <div className="bp-closed-actions">
        <select
          aria-label="Month"
          value={planMonth}
          onChange={(event) => {
            window.location.href = monthHref(event.target.value);
          }}
        >
          {[-1, 0, 1, 2].map((delta) => {
            const month = addMonths(planMonth, delta);
            return (
              <option key={month} value={month}>
                {monthLabel(month)}
              </option>
            );
          })}
        </select>
        <button type="button" className="wf-btn wf-btn-ghost" onClick={onExport} disabled={exportDisabled}>
          <Download size={15} /> Export
        </button>
      </div>
    </div>
  );
}
