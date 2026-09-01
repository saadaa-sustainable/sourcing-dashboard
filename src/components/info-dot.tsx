'use client';

import { useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { Info } from 'lucide-react';

// A small ⓘ that shows a help popover on hover/click. Portaled to <body> so it is
// immune to overflow:hidden on table cells / scroll containers.
export function InfoDot({ text, label = 'More info' }: { text: string; label?: string }) {
  const [open, setOpen] = useState(false);
  const [pos, setPos] = useState<{ top: number; left: number } | null>(null);
  const ref = useRef<HTMLButtonElement>(null);

  function show() {
    const r = ref.current?.getBoundingClientRect();
    if (r) setPos({ top: r.bottom + 6, left: Math.max(8, r.left - 8) });
    setOpen(true);
  }

  return (
    <>
      <button
        ref={ref}
        type="button"
        aria-label={label}
        onMouseEnter={show}
        onMouseLeave={() => setOpen(false)}
        onClick={(e) => {
          e.stopPropagation();
          open ? setOpen(false) : show();
        }}
        style={{
          background: 'none',
          border: 'none',
          cursor: 'help',
          color: '#9a9384',
          display: 'inline-flex',
          verticalAlign: 'middle',
          marginLeft: 4,
          padding: 0,
        }}
      >
        <Info size={13} />
      </button>
      {open &&
        pos &&
        createPortal(
          <div
            role="tooltip"
            style={{
              position: 'fixed',
              top: pos.top,
              left: pos.left,
              zIndex: 9999,
              maxWidth: 280,
              background: '#202124',
              color: '#fff',
              padding: '8px 10px',
              borderRadius: 6,
              fontSize: 12,
              fontWeight: 400,
              lineHeight: 1.4,
              boxShadow: '0 4px 16px rgba(0,0,0,0.25)',
            }}
          >
            {text}
          </div>,
          document.body,
        )}
    </>
  );
}
