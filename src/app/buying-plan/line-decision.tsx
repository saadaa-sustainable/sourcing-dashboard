'use client';

import { useState, useTransition } from 'react';
import { Check, RotateCcw, X } from 'lucide-react';
import { approveBuyingPlanLines, rejectBuyingPlanLines, reworkLines } from '@/lib/forms/actions';
import { statusText } from '@/lib/forms/approval';
import { reloadWithToast, toastError } from '@/lib/toast';
import type { SdStatus } from '@/lib/forms/types';

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
}: {
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
        fd.set('plan_id', String(planId));
        fd.set('line_ids', JSON.stringify([lineId]));
        r = await approveBuyingPlanLines(fd);
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
      <button type="button" className="bp-ld-btn approve" disabled={pending} onClick={() => run('approve')} title={`Approve ${label}`} aria-label={`Approve ${label}`}>
        <Check size={13} /> Approve
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
