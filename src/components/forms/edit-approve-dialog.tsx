'use client';

import { useEffect, useMemo, useState, useTransition } from 'react';
import { createPortal } from 'react-dom';
import { Check, PencilLine, Search, X } from 'lucide-react';
import { editAndApprove, getApprovalEditForm, type ActionResult } from '@/lib/forms/actions';
import type { ApprovalEditForm } from '@/lib/forms/approval-edit-types';
import type { ApprovalEntity } from '@/lib/forms/types';
import { toastError } from '@/lib/toast';

/**
 * Edit & approve: the approver changes submitted values and approves in one step. The editable
 * fields and their current values come from the server; changed cells are highlighted with the
 * submitted value shown beside them, and nothing is written until "Approve with edits".
 */
export function EditApproveDialog({
  entityType,
  entityId,
  entityLabel,
  initialNotes = '',
  onClose,
  onDone,
}: {
  entityType: ApprovalEntity;
  entityId: string;
  entityLabel: string;
  initialNotes?: string;
  onClose: () => void;
  onDone?: (result: ActionResult) => void;
}) {
  const [form, setForm] = useState<ApprovalEditForm | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [values, setValues] = useState<Record<string, string>>({});
  const [notes, setNotes] = useState(initialNotes);
  const [query, setQuery] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [pending, start] = useTransition();

  useEffect(() => {
    let live = true;
    getApprovalEditForm(entityType, entityId).then((res) => {
      if (!live) return;
      if (res.ok) setForm(res.form);
      else setLoadError(res.error);
    });
    return () => {
      live = false;
    };
  }, [entityType, entityId]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && !pending && onClose();
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose, pending]);

  const id = (ref: string, key: string) => `${ref}::${key}`;
  const current = (ref: string, key: string, original: string) => values[id(ref, key)] ?? original;
  const isChanged = (ref: string, key: string, original: string) => {
    const v = values[id(ref, key)];
    return v !== undefined && v.trim() !== original.trim() && !(v.trim() !== '' && original !== '' && Number(v.replace(/,/g, '')) === Number(original));
  };
  const changes = useMemo(() => {
    if (!form) return [];
    return form.rows.flatMap((r) =>
      r.fields.filter((fl) => isChanged(r.ref, fl.key, fl.value)).map((fl) => ({ ref: r.ref, key: fl.key, value: values[id(r.ref, fl.key)] ?? '' })),
    );
    // eslint-disable-next-line react-hooks/exhaustive-deps -- isChanged reads values, listed
  }, [form, values]);

  const shownRows = useMemo(() => {
    const q = query.trim().toLowerCase();
    return (form?.rows ?? []).filter((r) => !q || `${r.label} ${r.sub ?? ''}`.toLowerCase().includes(q));
  }, [form, query]);
  // The record itself shows as a form; its lines (same fields each) as one grid.
  const formRows = shownRows.filter((r) => r.ref === 'header');
  const gridRows = shownRows.filter((r) => r.ref !== 'header');
  const lineCount = (form?.rows ?? []).filter((r) => r.ref !== 'header').length;

  function submit() {
    setError(null);
    if (!changes.length) {
      setError('Nothing has been changed yet. Change a value, or close this and use Approve.');
      return;
    }
    const fd = new FormData();
    fd.set('entity_type', entityType);
    fd.set('entity_id', entityId);
    fd.set('entity_label', entityLabel);
    fd.set('notes', notes);
    fd.set('changes', JSON.stringify(changes));
    start(async () => {
      const result = await editAndApprove(fd);
      if (!result.ok) setError(toastError(result.error));
      else onClose();
      onDone?.(result);
    });
  }

  const input = (ref: string, fl: ApprovalEditForm['rows'][number]['fields'][number]) => {
    const changed = isChanged(ref, fl.key, fl.value);
    return (
      <div className={`ea-cell${changed ? ' is-changed' : ''}`}>
        {fl.kind === 'text' ? (
          <textarea
            className="wf-textarea"
            rows={2}
            value={current(ref, fl.key, fl.value)}
            onChange={(e) => setValues((v) => ({ ...v, [id(ref, fl.key)]: e.target.value }))}
            aria-label={fl.label}
          />
        ) : (
          <input
            className="wf-input"
            type={fl.kind === 'date' ? 'date' : 'text'}
            inputMode={fl.kind === 'int' ? 'numeric' : fl.kind === 'money' ? 'decimal' : undefined}
            value={current(ref, fl.key, fl.value)}
            onChange={(e) => setValues((v) => ({ ...v, [id(ref, fl.key)]: e.target.value }))}
            aria-label={fl.label}
          />
        )}
        {changed && <small>was {fl.value || '—'}</small>}
      </div>
    );
  };

  return createPortal(
    <div className="mo-layer" onMouseDown={(e) => e.target === e.currentTarget && !pending && onClose()}>
      <div className="mo ea" role="dialog" aria-modal="true" aria-label={`Edit and approve ${entityLabel}`}>
        <header className="mo-head">
          <div className="mo-head-main">
            <div className="mb-chips">
              <span className="mb-chip">Edit &amp; approve</span>
            </div>
            <h2>{form?.title ?? entityLabel}</h2>
            <p>Change what needs changing, then approve. Every change is recorded with the submitted value, and the submitter sees it was approved with your edits.</p>
          </div>
          <div className="mo-head-actions">
            <button type="button" className="mo-x" onClick={onClose} aria-label="Close" disabled={pending}>
              <X size={16} />
            </button>
          </div>
        </header>

        <div className="mo-body">
          {loadError ? (
            <p className="mb-warn mb-t-back">{loadError}</p>
          ) : !form ? (
            <p className="mo-empty">Loading the submitted values…</p>
          ) : (
            <>
              {form.note && <p className="ea-note">{form.note}</p>}
              {formRows.map((r) => (
                <section key={r.ref} className="mo-sec">
                  <div className="mo-sec-head">
                    <div>
                      <h3>{r.label}</h3>
                      {r.sub && <p>{r.sub}</p>}
                    </div>
                  </div>
                  <div className="ea-form">
                    {r.fields.map((fl) => (
                      <label key={fl.key} className={fl.kind === 'text' ? 'ea-wide' : undefined}>
                        <span>{fl.label}</span>
                        {input(r.ref, fl)}
                      </label>
                    ))}
                  </div>
                </section>
              ))}
              {gridRows.length > 0 && (
                <section className="mo-sec">
                  <div className="mo-sec-head">
                    <div>
                      <h3>Lines</h3>
                      <p>{lineCount} submitted · edit any value</p>
                    </div>
                    {lineCount > 8 && (
                      <label className="mb-search ea-search">
                        <Search size={14} aria-hidden="true" />
                        <input type="search" value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Find a line…" aria-label="Find a line" />
                      </label>
                    )}
                  </div>
                  <div className="mo-tablewrap ea-gridwrap">
                    <table className="wf-grid ea-grid">
                      <thead>
                        <tr>
                          <th>Line</th>
                          {gridRows[0].fields.map((fl) => (
                            <th key={fl.key} className={fl.kind === 'int' || fl.kind === 'money' ? 'num' : undefined}>{fl.label}</th>
                          ))}
                        </tr>
                      </thead>
                      <tbody>
                        {gridRows.map((r) => (
                          <tr key={r.ref} className={r.fields.some((fl) => isChanged(r.ref, fl.key, fl.value)) ? 'is-changed' : undefined}>
                            <td>
                              <b>{r.label}</b>
                              {r.sub && <small className="ea-sub">{r.sub}</small>}
                            </td>
                            {r.fields.map((fl) => (
                              <td key={fl.key}>{input(r.ref, fl)}</td>
                            ))}
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                </section>
              )}
              <section className="mo-sec">
                <div className="mo-sec-head">
                  <div>
                    <h3>Comment</h3>
                    <p>Optional. Recorded with the approval and sent to the submitter along with the list of changes.</p>
                  </div>
                </div>
                <textarea className="wf-textarea" rows={2} value={notes} onChange={(e) => setNotes(e.target.value)} placeholder="Why these values were changed" />
              </section>
            </>
          )}
          {error && <p className="wf-inline-error">{error}</p>}
        </div>

        <footer className="mo-foot">
          <span>
            {changes.length ? (
              <>
                <PencilLine size={13} aria-hidden="true" /> {changes.length} value{changes.length === 1 ? '' : 's'} changed
              </>
            ) : (
              'No changes yet'
            )}
          </span>
          <div className="ea-foot-actions">
            <button type="button" className="wf-btn wf-btn-ghost wf-btn-sm" onClick={onClose} disabled={pending}>
              Cancel
            </button>
            <button type="button" className="wf-btn wf-btn-primary wf-btn-sm" onClick={submit} disabled={pending || !form || !changes.length}>
              <Check size={14} /> {pending ? 'Approving…' : 'Approve with edits'}
            </button>
          </div>
        </footer>
      </div>
    </div>,
    document.body,
  );
}
