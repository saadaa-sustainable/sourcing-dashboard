'use client';

import { useState, useTransition } from 'react';
import { CalendarClock, Check, CircleAlert } from 'lucide-react';
import { submitFabricRate } from '@/lib/forms/actions';
import { Notice } from '@/components/forms/form-layout';
import type { FabricRateStatus } from '@/lib/fabric-rate-submission.server';

/**
 * Item 5 — the mandatory monthly fabric-rate submission surface. Every fabric must
 * be reviewed each month: submit a new grey/finished rate, or tick "No change".
 * Pending fabrics stay flagged at the top until submitted — the persistent
 * mandatory-task reminder (no Slack/email yet; that lands when a webhook is set).
 */
export function FabricRateSubmissionPanel({
  month,
  rows,
  pendingCount,
  editable,
}: {
  month: string;
  rows: FabricRateStatus[];
  pendingCount: number;
  editable: boolean;
}) {
  const monthLabel = new Date(`${month}T00:00:00Z`).toLocaleDateString('en-IN', {
    month: 'long',
    year: 'numeric',
    timeZone: 'UTC',
  });

  return (
    <div className="wf-fabric-sub">
      <p className="wf-subtle">
        Every fabric&rsquo;s rate must be reviewed monthly — update the grey / finished rate, or
        confirm <strong>No change</strong>. &ldquo;No change&rdquo; is a valid submission; a fabric with
        no submission for the month stays pending below.
      </p>

      {pendingCount > 0 ? (
        <div className="wf-sub-banner is-pending">
          <CircleAlert size={15} />
          <span>
            <strong>{pendingCount}</strong> fabric{pendingCount === 1 ? '' : 's'} still pending for{' '}
            <strong>{monthLabel}</strong>.
          </span>
        </div>
      ) : rows.length ? (
        <div className="wf-sub-banner is-done">
          <Check size={15} />
          <span>All fabrics reviewed for {monthLabel}.</span>
        </div>
      ) : null}

      <div className="table-panel wf-grid-panel">
        <div className="table-scroll">
          <table className="wf-grid">
            <thead>
              <tr>
                <th>Fabric</th>
                <th className="num">Grey (live)</th>
                <th className="num">Finished (live)</th>
                <th>This month</th>
                {editable && <th>Submit</th>}
              </tr>
            </thead>
            <tbody>
              {/* Pending first, so the mandatory ones are up top. */}
              {[...rows]
                .sort((a, b) => Number(a.submittedThisMonth) - Number(b.submittedThisMonth))
                .map((r) => (
                  <FabricRateRow key={r.fabric_code} row={r} editable={editable} />
                ))}
              {!rows.length && (
                <tr>
                  <td colSpan={editable ? 5 : 4} className="wf-empty-cell">
                    No fabrics in the cost base yet — add fabrics on the Fabric Cost page first.
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}

function FabricRateRow({ row, editable }: { row: FabricRateStatus; editable: boolean }) {
  const [open, setOpen] = useState(false);
  const [grey, setGrey] = useState('');
  const [finished, setFinished] = useState('');
  const [busy, start] = useTransition();
  const [err, setErr] = useState<string | null>(null);

  const disp = (v: number | null) => (v == null ? '—' : String(v));

  function submit(noChange: boolean) {
    setErr(null);
    const fd = new FormData();
    fd.set('fabric_code', row.fabric_code);
    fd.set('no_change', noChange ? 'true' : 'false');
    if (!noChange) {
      if (grey.trim()) fd.set('grey_rate', grey.trim());
      if (finished.trim()) fd.set('finished_rate', finished.trim());
    }
    start(async () => {
      const res = await submitFabricRate(fd);
      if (res.ok) {
        window.location.reload();
      } else {
        setErr(res.error);
      }
    });
  }

  return (
    <>
      <tr className={row.submittedThisMonth ? undefined : 'wf-row-attention'}>
        <td><strong>{row.fabric_code}</strong></td>
        <td className="num">{disp(row.grey_rate)}</td>
        <td className="num">{disp(row.finished_rate)}</td>
        <td>
          {row.submittedThisMonth ? (
            <span className="wf-tag-approved">
              <Check size={11} /> {row.noChange ? 'No change' : 'Updated'}
              {row.submittedBy ? ` · ${row.submittedBy}` : ''}
            </span>
          ) : (
            <span className="wf-tag-pending">
              <CalendarClock size={11} /> Pending
            </span>
          )}
        </td>
        {editable && (
          <td>
            <button
              type="button"
              className="wf-btn wf-btn-ghost wf-btn-sm"
              disabled={busy}
              onClick={() => setOpen((o) => !o)}
            >
              {row.submittedThisMonth ? 'Revise' : 'Submit'}
            </button>
          </td>
        )}
      </tr>
      {editable && open && (
        <tr>
          <td colSpan={5}>
            {err && <Notice tone="error">{err}</Notice>}
            <div className="wf-sub-form">
              <label className="field wf-field">
                <span>New grey rate</span>
                <input type="number" min={0} value={grey} onChange={(e) => setGrey(e.target.value)} placeholder={disp(row.grey_rate)} />
              </label>
              <label className="field wf-field">
                <span>New finished rate</span>
                <input type="number" min={0} value={finished} onChange={(e) => setFinished(e.target.value)} placeholder={disp(row.finished_rate)} />
              </label>
              <div className="wf-sub-form-actions">
                <button type="button" className="wf-btn wf-btn-primary wf-btn-sm" disabled={busy} onClick={() => submit(false)}>
                  {busy ? 'Saving…' : 'Submit new rate'}
                </button>
                <button type="button" className="wf-btn wf-btn-ghost wf-btn-sm" disabled={busy} onClick={() => submit(true)}>
                  No change this month
                </button>
              </div>
            </div>
          </td>
        </tr>
      )}
    </>
  );
}
