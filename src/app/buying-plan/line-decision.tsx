'use client';

import { useState, useTransition } from 'react';
import { Check, RotateCcw, X } from 'lucide-react';
import { approveBuyingPlanLines, editAndApprovePlanLines, rejectBuyingPlanLines, reworkLines } from '@/lib/forms/actions';
import { statusText } from '@/lib/forms/approval';
import { reloadWithToast, toastError } from '@/lib/toast';
import type { SdStatus } from '@/lib/forms/types';

/** Quantities the approver changed on screen for one line (only the changed fields). */
export type LineEdits = Partial<Record<'job_work_qty' | 'efob_qty' | 'fob_qty', number>>;

/** Approve, sending any on-screen quantity changes with it (saved as edited and approved). */
async function approveWithEdits(planId: number, lineIds: number[], editsFor: (id: number) => LineEdits | null) {
  const edits = lineIds.map((id) => ({ id, e: editsFor(id) })).filter((x) => x.e && Object.keys(x.e).length);
  const fd = new FormData();
  fd.set('plan_id', String(planId));
  if (!edits.length) {
    fd.set('line_ids', JSON.stringify(lineIds));
    return approveBuyingPlanLines(fd);
  }
  const edited = new Set(edits.map((x) => x.id));
  fd.set('edits', JSON.stringify(edits.map((x) => ({ lineId: x.id, ...x.e }))));
  fd.set('approve_ids', JSON.stringify(lineIds.filter((id) => !edited.has(id))));
  return editAndApprovePlanLines(fd);
}

/** Database id of a saved plan line from its row key (`line-123`); null for unsaved rows. */
export function lineIdOf(key: string): number | null {
  const m = /^line-(\d+)$/.exec(key);
  return m ? Number(m[1]) : null;
}

/**
 * Per-product decision on a plan awaiting approval: Approve, Rework or Reject this one line,
 * beside the plan-wide decision card. Rework and Reject ask for a reason inline (no browser
 * dialog). A line already decided shows its status.
 */
export function LineDecision({
  planId,
  lineKey,
  lineStatus,
  approverEdited,
  label,
  entityLabel,
  edits = null,
}: {
  /** Quantities changed on screen; Approve then saves them as edited and approved. */
  edits?: LineEdits | null;
  planId: number;
  lineKey: string;
  lineStatus: string | null;
  approverEdited?: boolean;
  label: string;
  entityLabel: string;
}) {
  const [asking, setAsking] = useState<null | 'rework' | 'reject'>(null);
  const [note, setNote] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [pending, start] = useTransition();
  const lineId = lineIdOf(lineKey);

  if (!lineId) return <span className="wf-subtle">Not saved</span>;
  if (lineStatus === 'approved' || lineStatus === 'rejected' || lineStatus === 'rework') {
    const tone = lineStatus === 'approved' ? 'green' : 'red';
    return <span className={`bp-badge ${tone}`}>{statusText(lineStatus as SdStatus, { approverEdited })}</span>;
  }

  function run(kind: 'approve' | 'rework' | 'reject') {
    setError(null);
    if (kind !== 'approve' && !note.trim()) {
      setError('Add a reason.');
      return;
    }
    const fd = new FormData();
    start(async () => {
      let r;
      if (kind === 'approve') {
        r = await approveWithEdits(planId, [lineId as number], () => edits);
      } else if (kind === 'reject') {
        fd.set('plan_id', String(planId));
        fd.set('line_ids', JSON.stringify([lineId]));
        fd.set('note', note.trim());
        r = await rejectBuyingPlanLines(fd);
      } else {
        fd.set('entity_type', 'buying_plan');
        fd.set('entity_id', String(planId));
        fd.set('entity_label', entityLabel);
        fd.set('line_decisions', JSON.stringify([{ lineId: String(lineId), note: note.trim() }]));
        r = await reworkLines(fd);
      }
      if (r.ok) reloadWithToast(r.message ?? 'Saved.');
      else setError(toastError(r.error));
    });
  }

  if (asking) {
    return (
      <span className="bp-line-decision asking">
        <input
          autoFocus
          value={note}
          onChange={(e) => setNote(e.target.value)}
          placeholder={asking === 'rework' ? 'What should change?' : 'Why reject this line?'}
          aria-label={`Reason to ${asking} ${label}`}
          onKeyDown={(e) => {
            if (e.key === 'Enter') run(asking);
            if (e.key === 'Escape') setAsking(null);
          }}
        />
        <button type="button" className={`wf-btn wf-btn-sm ${asking === 'reject' ? 'wf-btn-danger' : 'wf-btn-primary'}`} disabled={pending} onClick={() => run(asking)}>
          {pending ? '…' : asking === 'rework' ? 'Send back' : 'Reject'}
        </button>
        <button type="button" className="wf-btn wf-btn-ghost wf-btn-sm" disabled={pending} onClick={() => { setAsking(null); setError(null); }}>
          Cancel
        </button>
        {error && <span className="bp-line-decision-error">{error}</span>}
      </span>
    );
  }

  return (
    <span className="bp-line-decision">
      {edits && Object.keys(edits).length > 0 && <span className="bp-ld-edited" title="You changed this line's quantities; approving saves the new quantities">Edited</span>}
      <button
        type="button"
        className="bp-ld-btn approve"
        disabled={pending}
        onClick={() => run('approve')}
        title={edits && Object.keys(edits).length ? `Save your changes to ${label} and approve it` : `Approve ${label}`}
        aria-label={edits && Object.keys(edits).length ? `Edit and approve ${label}` : `Approve ${label}`}
      >
        <Check size={13} /> {edits && Object.keys(edits).length ? 'Edit & approve' : 'Approve'}
      </button>
      <button type="button" className="bp-ld-btn" disabled={pending} onClick={() => setAsking('rework')} title={`Send ${label} back for rework`} aria-label={`Send ${label} back for rework`}>
        <RotateCcw size={13} />
      </button>
      <button type="button" className="bp-ld-btn reject" disabled={pending} onClick={() => setAsking('reject')} title={`Reject ${label}`} aria-label={`Reject ${label}`}>
        <X size={13} />
      </button>
      {error && <span className="bp-line-decision-error">{error}</span>}
    </span>
  );
}

/**
 * Decide several plan lines at once (approver): Approve, Rework or Reject every ticked line.
 * Rework and Reject take one reason that is recorded on each line. Floats at the bottom of the
 * screen while lines are ticked.
 */
export function BulkDecisionBar({
  planId,
  entityLabel,
  keys,
  value,
  onClear,
  editsFor,
}: {
  /** On-screen quantity changes per line key; approved lines with changes are saved as edited. */
  editsFor?: (key: string) => LineEdits | null;
  planId: number;
  entityLabel: string;
  keys: string[];
  /** Plan value of the ticked lines, already formatted. */
  value: string;
  onClear: () => void;
}) {
  const [asking, setAsking] = useState<null | 'rework' | 'reject'>(null);
  const [note, setNote] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [pending, start] = useTransition();
  const ids = keys.map(lineIdOf).filter((n): n is number => n != null);
  const editedCount = editsFor ? keys.filter((k) => { const e = editsFor(k); return e && Object.keys(e).length; }).length : 0;
  if (!ids.length) return null;

  function run(kind: 'approve' | 'rework' | 'reject') {
    setError(null);
    if (kind !== 'approve' && !note.trim()) {
      setError('Add a reason — it is recorded on each line.');
      return;
    }
    const fd = new FormData();
    start(async () => {
      let r;
      if (kind === 'approve') {
        r = await approveWithEdits(planId, ids, (id) => editsFor?.(`line-${id}`) ?? null);
      } else if (kind === 'reject') {
        fd.set('plan_id', String(planId));
        fd.set('line_ids', JSON.stringify(ids));
        fd.set('note', note.trim());
        r = await rejectBuyingPlanLines(fd);
      } else {
        fd.set('entity_type', 'buying_plan');
        fd.set('entity_id', String(planId));
        fd.set('entity_label', entityLabel);
        fd.set('line_decisions', JSON.stringify(ids.map((id) => ({ lineId: String(id), note: note.trim() }))));
        r = await reworkLines(fd);
      }
      if (r.ok) reloadWithToast(r.message ?? 'Saved.');
      else setError(toastError(r.error));
    });
  }

  return (
    <div className="bp-bulk-bar" role="region" aria-label="Decide the ticked lines">
      <span className="bp-bulk-count">
        <b>{ids.length}</b> line{ids.length === 1 ? '' : 's'} ticked · {value}
      </span>
      {asking ? (
        <>
          <input
            autoFocus
            value={note}
            onChange={(e) => setNote(e.target.value)}
            placeholder={asking === 'rework' ? 'What should change on these lines?' : 'Why reject these lines?'}
            aria-label={`Reason to ${asking} the ticked lines`}
            onKeyDown={(e) => {
              if (e.key === 'Enter') run(asking);
              if (e.key === 'Escape') setAsking(null);
            }}
          />
          <button type="button" className="bp-bulk-btn strong" disabled={pending} onClick={() => run(asking)}>
            {pending ? 'Saving…' : asking === 'rework' ? `Send ${ids.length} back` : `Reject ${ids.length}`}
          </button>
          <button type="button" className="bp-bulk-btn" disabled={pending} onClick={() => { setAsking(null); setError(null); }}>
            Cancel
          </button>
        </>
      ) : (
        <>
          <button type="button" className="bp-bulk-btn strong" disabled={pending} onClick={() => run('approve')}>
            <Check size={13} /> {pending ? 'Saving…' : `Approve ${ids.length}`}{editedCount ? ` (${editedCount} edited)` : ''}
          </button>
          <button type="button" className="bp-bulk-btn" disabled={pending} onClick={() => setAsking('rework')}>
            <RotateCcw size={13} /> Rework
          </button>
          <button type="button" className="bp-bulk-btn" disabled={pending} onClick={() => setAsking('reject')}>
            <X size={13} /> Reject
          </button>
          <button type="button" className="bp-bulk-btn" disabled={pending} onClick={onClear}>
            Clear
          </button>
        </>
      )}
      {error && <span className="bp-bulk-error">{error}</span>}
    </div>
  );
}
