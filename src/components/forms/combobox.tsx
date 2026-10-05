'use client';

import { useEffect, useId, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { ChevronDown } from 'lucide-react';

export type ComboOption = {
  /** What is stored when the option is picked. */
  value: string;
  /** The bold first line — the name people recognise. */
  label: string;
  /** The grey second line — code, type, anything that tells two similar names apart. */
  detail?: string;
  /** Extra text matched by the search but not shown (e.g. the code when the label is a name). */
  keywords?: string;
};

/**
 * A searchable dropdown: type to filter, pick a row with the mouse or the arrow keys and
 * Enter. Each row is a bold name over a grey detail line. The list is a fixed overlay
 * anchored to the input, so tables and panels below never clip it. With `allowFreeText`
 * (the default) whatever is typed is kept even if it matches no option.
 */
export function Combobox({
  value,
  onChange,
  options,
  placeholder = 'Select or type…',
  allowFreeText = true,
  disabled = false,
  emptyText = 'Nothing matches.',
  onPick,
  limit = 80,
  ariaLabel,
}: {
  value: string;
  onChange: (v: string) => void;
  options: ComboOption[];
  placeholder?: string;
  allowFreeText?: boolean;
  disabled?: boolean;
  emptyText?: string;
  /** Called with the whole option when one is picked from the list. */
  onPick?: (o: ComboOption) => void;
  limit?: number;
  ariaLabel?: string;
}) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState<string | null>(null);
  const [active, setActive] = useState(0);
  const [pos, setPos] = useState<{ top: number; left: number; width: number; up: boolean } | null>(null);
  const rootRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const listId = useId();

  // While typing, filter on what is typed; on open with no typing, show everything.
  const q = (query ?? '').trim().toLowerCase();
  const matches = useMemo(() => {
    if (!q) return options.slice(0, limit);
    return options
      .filter((o) => `${o.label} ${o.detail ?? ''} ${o.value} ${o.keywords ?? ''}`.toLowerCase().includes(q))
      .slice(0, limit);
  }, [q, options, limit]);
  const selected = options.find((o) => o.value === value);

  const place = () => {
    const el = inputRef.current;
    if (!el) return;
    const r = el.getBoundingClientRect();
    const below = window.innerHeight - r.bottom;
    const up = below < 260 && r.top > below;
    setPos({ top: up ? r.top - 4 : r.bottom + 4, left: r.left, width: r.width, up });
  };
  useLayoutEffect(() => {
    if (open) place();
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const onScroll = (e: Event) => {
      if (listRef.current && e.target instanceof Node && listRef.current.contains(e.target)) return;
      place();
    };
    const onDown = (e: Event) => {
      const t = e.target as Node;
      if (!rootRef.current?.contains(t) && !listRef.current?.contains(t)) {
        setOpen(false);
        setQuery(null);
      }
    };
    window.addEventListener('scroll', onScroll, true);
    window.addEventListener('resize', place);
    document.addEventListener('mousedown', onDown);
    return () => {
      window.removeEventListener('scroll', onScroll, true);
      window.removeEventListener('resize', place);
      document.removeEventListener('mousedown', onDown);
    };
  }, [open]);

  // Keep the highlighted row in view as the arrow keys move it.
  useEffect(() => {
    if (!open) return;
    listRef.current?.querySelector<HTMLElement>(`[data-i="${active}"]`)?.scrollIntoView({ block: 'nearest' });
  }, [active, open]);

  function pick(o: ComboOption) {
    onChange(o.value);
    onPick?.(o);
    setQuery(null);
    setOpen(false);
  }

  return (
    <div className="wf-combo" ref={rootRef}>
      <div className={`wf-combo-input${open ? ' is-open' : ''}${disabled ? ' is-disabled' : ''}`}>
        <input
          ref={inputRef}
          role="combobox"
          aria-expanded={open}
          aria-controls={listId}
          aria-autocomplete="list"
          aria-label={ariaLabel}
          value={query ?? value}
          placeholder={placeholder}
          disabled={disabled}
          onFocus={() => { setOpen(true); setActive(0); }}
          onChange={(e) => {
            setQuery(e.target.value);
            setActive(0);
            setOpen(true);
            if (allowFreeText) onChange(e.target.value);
          }}
          onKeyDown={(e) => {
            if (e.key === 'ArrowDown') { e.preventDefault(); setOpen(true); setActive((a) => Math.min(a + 1, matches.length - 1)); }
            else if (e.key === 'ArrowUp') { e.preventDefault(); setActive((a) => Math.max(a - 1, 0)); }
            else if (e.key === 'Enter' && open && matches[active]) { e.preventDefault(); pick(matches[active]); }
            else if (e.key === 'Escape') { setOpen(false); setQuery(null); }
            else if (e.key === 'Tab') { setOpen(false); setQuery(null); }
          }}
        />
        <ChevronDown size={14} className="wf-combo-caret" aria-hidden="true" onMouseDown={(e) => { e.preventDefault(); if (!disabled) { setOpen((v) => !v); inputRef.current?.focus(); } }} />
      </div>
      {selected?.detail && !open && <span className="wf-combo-selected-detail">{selected.detail}</span>}
      {open && !disabled && pos && (
        <div
          ref={listRef}
          id={listId}
          role="listbox"
          className="wf-combo-list"
          style={{
            position: 'fixed',
            left: pos.left,
            width: Math.max(pos.width, 260),
            ...(pos.up ? { bottom: window.innerHeight - pos.top } : { top: pos.top }),
          }}
        >
          {matches.map((o, i) => (
            <div
              key={`${o.value}-${i}`}
              data-i={i}
              role="option"
              aria-selected={o.value === value}
              className={`wf-combo-item${i === active ? ' is-active' : ''}${o.value === value ? ' is-selected' : ''}`}
              onMouseEnter={() => setActive(i)}
              // mousedown + preventDefault: the input keeps focus and the pick is never lost.
              onMouseDown={(e) => { e.preventDefault(); pick(o); }}
            >
              <span className="wf-combo-label">{o.label}</span>
              {o.detail && <span className="wf-combo-detail">{o.detail}</span>}
            </div>
          ))}
          {!matches.length && (
            <div className="wf-combo-empty">{allowFreeText && q ? `No match — “${query?.trim()}” will be kept as typed.` : emptyText}</div>
          )}
        </div>
      )}
    </div>
  );
}
