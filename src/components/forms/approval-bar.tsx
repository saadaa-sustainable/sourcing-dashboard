'use client';

import { useState, useTransition } from 'react';
import { Check, X } from 'lucide-react';
import { decideApproval, type ActionResult } from '@/lib/forms/actions';
import type { ApprovalEntity } from '@/lib/forms/types';

/**
 * Approve / reject control.
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
  const [rejecting, setRejecting] = useState(false);
  const [notes, setNotes] = useState('');
  const [error, setError] = useState<string | null>(null);

  function decide(decision: 'approve' | 'reject') {
    setError(null);
    if (decision === 'reject' && !notes.trim()) {
      setError('Give a reason so the submitter knows what to change.');
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
      if (!result.ok) setError(result.error);
      else {
        setRejecting(false);
        setNotes('');
      }
      onDone?.(result);
    });
  }

  return (
    <div className="wf-approval-bar">
      {rejecting && (
        <textarea
          className="wf-textarea"
          rows={2}
          placeholder="Reason for rejection — sent to the submitter"
          value={notes}
          onChange={(event) => setNotes(event.target.value)}
        />
      )}
      <div className="wf-approval-actions">
        {rejecting ? (
          <>
            <button
              type="button"
              className="wf-btn wf-btn-danger"
              disabled={pending}
              onClick={() => decide('reject')}
            >
              {pending ? 'Working…' : 'Confirm reject'}
            </button>
            <button
              type="button"
              className="wf-btn wf-btn-ghost"
              onClick={() => {
                setRejecting(false);
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
            <button
              type="button"
              className="wf-btn wf-btn-ghost"
              onClick={() => setRejecting(true)}
            >
              <X size={15} /> Reject
            </button>
          </>
        )}
      </div>
      {error && <p className="wf-inline-error">{error}</p>}
    </div>
  );
}
