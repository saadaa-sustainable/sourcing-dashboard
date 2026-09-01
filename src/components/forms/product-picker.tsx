'use client';

import { useMemo, useRef, useState } from 'react';
import { Search } from 'lucide-react';
import type { ProductCatalogItem } from '@/lib/forms/types';

/**
 * Searchable "Add Product" picker — type a product code or product name, click the
 * match to add it. Sourced from the product master (sd_product_catalog). `exclude`
 * hides products already on the sheet.
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
  const blurTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

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

  function pick(code: string) {
    onPick(code);
    setQ('');
    setOpen(false);
  }

  return (
    <div className="wf-picker">
      <div className="wf-picker-input">
        <Search size={15} />
        <input
          value={q}
          placeholder={placeholder}
          disabled={disabled}
          onChange={(e) => {
            setQ(e.target.value);
            setOpen(true);
          }}
          onFocus={() => setOpen(true)}
          onBlur={() => {
            blurTimer.current = setTimeout(() => setOpen(false), 150);
          }}
        />
      </div>
      {open && !disabled && (
        <div
          className="wf-picker-list"
          onMouseDown={() => {
            if (blurTimer.current) clearTimeout(blurTimer.current);
          }}
        >
          {matches.map((i) => (
            <button
              type="button"
              key={i.product_code}
              className="wf-picker-item"
              onClick={() => pick(i.product_code)}
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
