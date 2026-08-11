'use client';

import { useState, useTransition } from 'react';
import { createPortal } from 'react-dom';
import { RotateCcw, X } from 'lucide-react';
import { reworkLines, type ActionResult } from '@/lib/forms/actions';
import type { ApprovalEntity } from '@/lib/forms/types';

/**
 * Line-item Rework/Reassign. Opens a pop-up listing the record's lines; the
 * approver types a reason against each line they are sending back (each line
 * captures its own reason). Only lines with a reason are reverted.
 */
export function LineRework({
  entityType,
  entityId,
  entityLabel,
  lines,
  onDone,
}: {
  entityType: ApprovalEntity;
  entityId: string;
  entityLabel: string;
  lines: { id: string; label: string }[];
  onDone?: (result: ActionResult) => void;
}) {
  const [open, setOpen] = useState(false);
  const [notes, setNotes] = useState<Record<string, string>>({});
  const [pending, start] = useTransition();
  const [error, setError] = useState<string | null>(null);

  function submit() {
    setError(null);
    const decisions = Object.entries(notes)
      .filter(([, note]) => note.trim())
      .map(([lineId, note]) => ({ lineId, note: note.trim() }));
    if (!decisions.length) {
      setError('Add a reason to at least one line.');
      return;
    }
    const payload = new FormData();
    payload.set('entity_type', entityType);
    payload.set('entity_id', entityId);
    payload.set('entity_label', entityLabel);
    payload.set('line_decisions', JSON.stringify(decisions));
    start(async () => {
      const result = await reworkLines(payload);
      if (!result.ok) setError(result.error);
      else {
        setOpen(false);
        setNotes({});
      }
      onDone?.(result);
    });
  }

  return (
    <>
      <button type="button" className="wf-btn wf-btn-ghost" onClick={() => setOpen(true)}>
        <RotateCcw size={15} /> Rework lines
      </button>
      {open &&
        createPortal(
          <div className="modal-backdrop" onMouseDown={() => setOpen(false)}>
            <div
              className="modal"
              role="dialog"
              aria-modal="true"
              aria-label="Rework lines"
              onMouseDown={(event) => event.stopPropagation()}
            >
              <div className="modal-head">
                <h2>Rework / Reassign lines</h2>
                <button className="icon-button" onClick={() => setOpen(false)} aria-label="Close">
                  <X size={18} />
                </button>
              </div>
              <div className="wf-line-rework">
                <p className="wf-subtle">
                  Give a reason for each line you are sending back — it is recorded against that
                  line. Leave a line blank to keep it.
                </p>
                {lines.map((line) => (
                  <label key={line.id} className="wf-line-rework-row">
                    <span>{line.label}</span>
                    <input
                      placeholder="Reason (blank = keep)"
                      value={notes[line.id] ?? ''}
                      onChange={(event) =>
                        setNotes((current) => ({ ...current, [line.id]: event.target.value }))
                      }
                    />
                  </label>
                ))}
                {error && <p className="wf-inline-error">{error}</p>}
                <div className="wf-footer-actions">
                  <button
                    type="button"
                    className="wf-btn wf-btn-primary"
                    disabled={pending}
                    onClick={submit}
                  >
                    {pending ? 'Working…' : 'Send flagged lines for rework'}
                  </button>
                  <button
                    type="button"
                    className="wf-btn wf-btn-ghost"
                    onClick={() => setOpen(false)}
                  >
                    Cancel
                  </button>
                </div>
              </div>
            </div>
          </div>,
          document.body,
        )}
    </>
  );
}
