'use client';

import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { Info } from 'lucide-react';

/**
 * A small ⓘ that shows a help popover on hover/click.
 *
 * Portaled to <body> so it is immune to `overflow: hidden` on table cells and scroll
 * containers, and positioned so it always FITS: a popover that merely overflows the right
 * edge is not clipped by the browser, it is squeezed — the text reflows to two words a line
 * and runs off the bottom of the screen, which is what made these unreadable on the
 * right-hand columns of a wide table.
 *
 * So the box is given an explicit width and then clamped inside the viewport, and it flips
 * above the icon when there is more room up there. Anchoring the flipped case with `bottom`
 * rather than `top` means its height never has to be measured first.
 */
const WIDTH = 340;
const GAP = 6; // between the icon and the box
const EDGE = 8; // smallest gap to a viewport edge

type Pos = {
  left: number;
  width: number;
  maxHeight: number;
  top?: number;
  bottom?: number;
};

export function InfoDot({ text, label = 'More info' }: { text: string; label?: string }) {
  const [open, setOpen] = useState(false);
  const [pos, setPos] = useState<Pos | null>(null);
  const ref = useRef<HTMLButtonElement>(null);

  function show() {
    const r = ref.current?.getBoundingClientRect();
    if (!r) return;
    const vw = window.innerWidth;
    const vh = window.innerHeight;
    const width = Math.min(WIDTH, vw - EDGE * 2);
    // Near the right edge there is no room to the right of the icon, so slide the box left
    // until it fits rather than letting it spill.
    const left = Math.min(Math.max(EDGE, r.left - EDGE), vw - width - EDGE);
    const below = vh - r.bottom - GAP - EDGE;
    const above = r.top - GAP - EDGE;
    setPos(
      below < 160 && above > below
        ? { left, width, bottom: vh - r.top + GAP, maxHeight: above }
        : { left, width, top: r.bottom + GAP, maxHeight: below },
    );
    setOpen(true);
  }

  // A fixed-position box would otherwise sit still while the page scrolls out from under
  // it, leaving the help floating beside the wrong row.
  useEffect(() => {
    if (!open) return;
    const close = () => setOpen(false);
    window.addEventListener('scroll', close, true); // capture: inner scrollers too
    window.addEventListener('resize', close);
    return () => {
      window.removeEventListener('scroll', close, true);
      window.removeEventListener('resize', close);
    };
  }, [open]);

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
          if (open) setOpen(false);
          else show();
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
              left: pos.left,
              ...(pos.top != null ? { top: pos.top } : { bottom: pos.bottom }),
              width: pos.width,
              // Long help text scrolls inside the box instead of running off the screen.
              maxHeight: Math.max(120, pos.maxHeight),
              overflowY: 'auto',
              zIndex: 9999,
              whiteSpace: 'pre-line',
              background: '#202124',
              color: '#fff',
              padding: '10px 12px',
              borderRadius: 6,
              fontSize: 12,
              fontWeight: 400,
              lineHeight: 1.5,
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
