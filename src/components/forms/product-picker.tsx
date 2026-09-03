'use client';

import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { Search } from 'lucide-react';
import type { ProductCatalogItem } from '@/lib/forms/types';

/**
 * Searchable "Add Product" picker — type a product code or product name, click the
 * match to add it. Sourced from the product master (sd_product_catalog). `exclude`
 * hides products already on the sheet.
 *
 * The results list renders as a position:fixed overlay anchored to the input, so
 * it is never overlapped or clipped by the table / panels below it — every row is
 * clickable across its full width (a plain absolute dropdown sat *under* the grid,
 * so only the non-overlapped slivers registered clicks).
 */
export function ProductPicker({
  items,
  onPick,
  exclude,
  placeholder = 'Search product code or name…',
  disabled = false,
}: {
  items: ProductCatalogItem[];
  onPick: (code: string) => void;
  exclude?: Set<string>;
  placeholder?: string;
  disabled?: boolean;
}) {
  const [q, setQ] = useState('');
  const [open, setOpen] = useState(false);
  const [pos, setPos] = useState<{ top: number; left: number; width: number } | null>(null);
  const rootRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  const matches = useMemo(() => {
    const pool = exclude ? items.filter((i) => !exclude.has(i.product_code)) : items;
    const query = q.trim().toLowerCase();
    if (!query) return pool.slice(0, 50);
    return pool
      .filter(
        (i) =>
          i.product_code.toLowerCase().includes(query) ||
          (i.product_name ?? '').toLowerCase().includes(query),
      )
      .slice(0, 50);
  }, [q, items, exclude]);

  // Anchor the fixed overlay to the input's current box.
  const place = () => {
    const el = inputRef.current;
    if (!el) return;
    const r = el.getBoundingClientRect();
    setPos({ top: r.bottom + 4, left: r.left, width: r.width });
  };
  useLayoutEffect(() => {
    if (open) place();
  }, [open]);

  // Reposition on scroll / resize while open; close on outside interaction / Escape.
  useEffect(() => {
    if (!open) return;
    const onScrollResize = () => place();
    const onDown = (e: Event) => {
      if (!rootRef.current?.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setOpen(false); };
    window.addEventListener('scroll', onScrollResize, true);
    window.addEventListener('resize', onScrollResize);
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onKey);
    return () => {
      window.removeEventListener('scroll', onScrollResize, true);
      window.removeEventListener('resize', onScrollResize);
      document.removeEventListener('mousedown', onDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);

  function pick(code: string) {
    onPick(code);
    setQ('');
    setOpen(false);
  }

  return (
    <div className="wf-picker" ref={rootRef}>
      <div className="wf-picker-input">
        <Search size={15} />
        <input
          ref={inputRef}
          value={q}
          placeholder={placeholder}
          disabled={disabled}
          onChange={(e) => {
            setQ(e.target.value);
            setOpen(true);
          }}
          onFocus={() => setOpen(true)}
        />
      </div>
      {open && !disabled && pos && (
        <div
          className="wf-picker-list"
          style={{ position: 'fixed', top: pos.top, left: pos.left, width: pos.width }}
        >
          {matches.map((i) => (
            <button
              type="button"
              key={i.product_code}
              className="wf-picker-item"
              // Pick on mousedown + preventDefault so the input never blurs and
              // the click can't be lost. Fires anywhere on the row (code or name).
              onMouseDown={(e) => {
                e.preventDefault();
                pick(i.product_code);
              }}
            >
              <span className="mono wf-picker-code">{i.product_code}</span>
              <span className="wf-picker-name">{i.product_name ?? '—'}</span>
            </button>
          ))}
          {!matches.length && <div className="wf-picker-empty">No products match.</div>}
        </div>
      )}
    </div>
  );
}
