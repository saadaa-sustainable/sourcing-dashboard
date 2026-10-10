'use client';

import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { AlertTriangle } from 'lucide-react';
import type { ConfirmRequest } from '@/lib/confirm';

type Pending = ConfirmRequest & { resolve: (ok: boolean) => void };

/**
 * The delete confirmation every deletion goes through (see lib/confirm.ts): a full-screen
 * overlay with a centred card, the warning, and Cancel (focused) / Delete. Escape or a click on
 * the overlay cancels. Mounted once in the root layout.
 */
export function ConfirmHost() {
  const [pending, setPending] = useState<Pending | null>(null);
  const openRef = useRef<Pending | null>(null);
  const cancelRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    const onAsk = (e: Event) => {
      const detail = (e as CustomEvent<Pending>).detail;
      e.preventDefault(); // tell confirmDelete a host took the request
      openRef.current?.resolve(false); // a second request replaces (and refuses) an open one
      openRef.current = detail;
      setPending(detail);
    };
    window.addEventListener('sd-confirm', onAsk);
    return () => window.removeEventListener('sd-confirm', onAsk);
  }, []);

  useEffect(() => {
    if (!pending) return;
    cancelRef.current?.focus();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') close(false);
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
    // close is stable for this pending request
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pending]);

  function close(ok: boolean) {
    openRef.current?.resolve(ok);
    openRef.current = null;
    setPending(null);
  }

  if (!pending) return null;
  return createPortal(
    <div className="sd-confirm-layer" role="presentation" onMouseDown={(e) => { if (e.target === e.currentTarget) close(false); }}>
      <div className="sd-confirm" role="alertdialog" aria-modal="true" aria-labelledby="sd-confirm-title" aria-describedby="sd-confirm-body">
        <div className="sd-confirm-icon" aria-hidden="true">
          <AlertTriangle size={22} />
        </div>
        <h2 id="sd-confirm-title">{pending.title}</h2>
        <p id="sd-confirm-body">{pending.body ?? 'This cannot be undone from the screen.'}</p>
        <div className="sd-confirm-actions">
          <button ref={cancelRef} type="button" className="wf-btn wf-btn-ghost" onClick={() => close(false)}>
            Cancel
          </button>
          <button type="button" className="wf-btn wf-btn-danger" onClick={() => close(true)}>
            {pending.confirmLabel ?? 'Delete'}
          </button>
        </div>
      </div>
    </div>,
    document.body,
  );
}
