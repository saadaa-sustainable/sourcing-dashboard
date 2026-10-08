'use client';

import { useState, useTransition } from 'react';
import { toastError } from '@/lib/toast';
import { Check, PencilLine, RotateCcw, X } from 'lucide-react';
import { decideApproval, type ActionResult } from '@/lib/forms/actions';
import type { ApprovalEntity } from '@/lib/forms/types';
import { EDITABLE_APPROVALS } from '@/lib/forms/approval-edit-types';
import { EditApproveDialog } from './edit-approve-dialog';

/**
 * Approve / edit & approve / rework / reject control.
 *
 * Edit & approve (where the record has values to edit) opens a dialog in which the approver
 * changes the submitted values and approves in one step; the changes are recorded.
 *
 * Rejection requires a reason: the submitter has to know what to change, and
 * an empty rejection produces a plan that bounces between the two of them.
 */
export function ApprovalBar({
  entityType,
  entityId,
  entityLabel,
  onDone,
}: {
  entityType: ApprovalEntity;
  entityId: string;
  entityLabel: string;
  onDone?: (result: ActionResult) => void;
}) {
  const [pending, start] = useTransition();
  const [mode, setMode] = useState<null | 'reject' | 'rework'>(null);
  const [notes, setNotes] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [editing, setEditing] = useState(false);
  const canEditApprove = (EDITABLE_APPROVALS as readonly string[]).includes(entityType);

  function decide(decision: 'approve' | 'reject' | 'rework') {
    setError(null);
    if ((decision === 'reject' || decision === 'rework') && !notes.trim()) {
      setError('A remark is mandatory for Rework / Reassign and Reject / Discard.');
      return;
    }
    const payload = new FormData();
    payload.set('entity_type', entityType);
    payload.set('entity_id', entityId);
    payload.set('entity_label', entityLabel);
    payload.set('decision', decision);
    payload.set('notes', notes);

    start(async () => {
      const result = await decideApproval(payload);
      if (!result.ok) setError(toastError(result.error));
      else {
        setMode(null);
        setNotes('');
      }
      onDone?.(result);
    });
  }

  return (
    <div className="wf-approval-bar">
      <textarea
        className="wf-textarea"
        rows={2}
        placeholder={
          mode === 'reject'
            ? 'Remark for Reject / Discard (required) — sent to the submitter'
            : mode === 'rework'
              ? 'Remark for Rework / Reassign (required) — sent to the submitter'
              : 'Comment (optional) — recorded with your approval'
        }
        value={notes}
        onChange={(event) => setNotes(event.target.value)}
      />

      <div className="wf-approval-actions">
        {mode ? (
          <>
            <button
              type="button"
              className={mode === 'reject' ? 'wf-btn wf-btn-danger' : 'wf-btn wf-btn-primary'}
              disabled={pending}
              onClick={() => decide(mode)}
            >
              {pending
                ? 'Working…'
                : mode === 'reject'
                  ? 'Confirm Reject / Discard'
                  : 'Confirm Rework / Reassign'}
            </button>
            <button
              type="button"
              className="wf-btn wf-btn-ghost"
              onClick={() => {
                setMode(null);
                setError(null);
              }}
            >
              Cancel
            </button>
          </>
        ) : (
          <>
            <button
              type="button"
              className="wf-btn wf-btn-primary"
              disabled={pending}
              onClick={() => decide('approve')}
            >
              <Check size={15} /> {pending ? 'Working…' : 'Approve'}
            </button>
            {canEditApprove && (
              <button type="button" className="wf-btn wf-btn-ghost" disabled={pending} onClick={() => setEditing(true)}>
                <PencilLine size={15} /> Edit &amp; approve
              </button>
            )}
            <button
              type="button"
              className="wf-btn wf-btn-ghost"
              onClick={() => setMode('rework')}
            >
              <RotateCcw size={15} /> Rework / Reassign
            </button>
            <button
              type="button"
              className="wf-btn wf-btn-ghost"
              onClick={() => setMode('reject')}
            >
              <X size={15} /> Reject / Discard
            </button>
          </>
        )}
      </div>
      {error && <p className="wf-inline-error">{error}</p>}
      {editing && (
        <EditApproveDialog
          entityType={entityType}
          entityId={entityId}
          entityLabel={entityLabel}
          initialNotes={notes}
          onClose={() => setEditing(false)}
          onDone={(result) => {
            if (result.ok) setNotes('');
            onDone?.(result);
          }}
        />
      )}
    </div>
  );
}
