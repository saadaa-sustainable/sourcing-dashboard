'use client';

import { useEffect, useState } from 'react';
import { createPortal } from 'react-dom';
import { Trash2, X } from 'lucide-react';

/** Why a request was deleted. Free text is allowed — these just cover the usual cases. */
const REASONS = [
  'Raised by mistake',
  'Duplicate of another request',
  'Wrong vendor',
  'Wrong product or quantity',
  'Requirement dropped',
  'Replaced by a revised request',
];

/**
 * The confirmation before a raised PO request is deleted. The reason is mandatory:
 * the row is kept and shown to admin with whoever deleted it, so "why" is the whole
 * point of the dialog. Portals to <body> — it opens from inside a table row.
 */
export function DeleteRequestModal({
  requestId,
  productCode,
  statusLabel,
  needsApproval,
  pending,
  onConfirm,
  onCancel,
}: {
  requestId: string;
  productCode: string | null;
  statusLabel: string;
  /** True for everyone but an admin: this raises a request rather than deleting outright. */
  needsApproval: boolean;
  pending: boolean;
  onConfirm: (reason: string) => void;
  onCancel: () => void;
}) {
  const [pick, setPick] = useState('');
  const [note, setNote] = useState('');
  const [host, setHost] = useState<HTMLElement | null>(null);
  useEffect(() => {
    const t = window.setTimeout(() => setHost(document.body), 0);
    return () => window.clearTimeout(t);
  }, []);

  const reason = [pick, note.trim()].filter(Boolean).join(' — ');
  const ready = reason.trim().length >= 4;

  if (!host) return null;
  return createPortal(
    <div className="pc-backdrop" role="dialog" aria-modal="true" aria-label="Delete this request">
      <div className="pc-modal pc-modal-sm">
        <div className="pc-head">
          <div>
            <span className="panel-kicker">{needsApproval ? 'Request deletion' : 'Delete request'}</span>
            <h3>
              {requestId}
              {productCode ? ` · ${productCode}` : ''} · {statusLabel}
            </h3>
            <p className="wf-subtle">
              {needsApproval
                ? 'Deleting goes to the admin like any other approval. This request stays live until they decide; your reason is what they decide on.'
                : 'It leaves the working lists straight away — you are the approver. The record is kept, with your reason, in the deleted log.'}
            </p>
          </div>
          <button type="button" className="wf-icon-btn" onClick={onCancel} aria-label="Close">
            <X size={16} />
          </button>
        </div>

        <section className="pc-section">
          <label className="pc-remark">
            <span>Reason <em>— required</em></span>
            <select value={pick} onChange={(e) => setPick(e.target.value)}>
              <option value="">— pick a reason —</option>
              {REASONS.map((r) => (
                <option key={r} value={r}>
                  {r}
                </option>
              ))}
            </select>
          </label>
          <label className="pc-remark">
            <span>Anything to add {pick ? <em>(optional)</em> : <em>— or type your own reason</em>}</span>
            <textarea
              className="wf-textarea"
              rows={2}
              value={note}
              placeholder="e.g. vendor confirmed they cannot take it this month; re-raising against KVN"
              onChange={(e) => setNote(e.target.value)}
            />
          </label>
        </section>

        <div className="pc-foot">
          <button type="button" className="wf-btn wf-btn-ghost" onClick={onCancel} disabled={pending}>
            Keep it
          </button>
          <button
            type="button"
            className="wf-btn wf-btn-danger"
            onClick={() => onConfirm(reason)}
            disabled={pending || !ready}
            title={ready ? undefined : 'Pick a reason or type one'}
          >
            <Trash2 size={14} />{' '}
            {pending
              ? needsApproval
                ? 'Sending…'
                : 'Deleting…'
              : needsApproval
                ? 'Send to admin'
                : 'Delete request'}
          </button>
        </div>
      </div>
    </div>,
    host,
  );
}
