'use client';

import { useState, type ReactNode } from 'react';

/**
 * Click-to-sort for hand-rolled tables (editable grids, custom lists) that can't use
 * the read-only FilterTable but should still sort like it. Adoption is two lines:
 *
 *   const sort = useColumnSort<Row>();
 *   // header cell:  <th {...sort.th('name', r => r.name)}>Name {sort.ind('name')}</th>
 *   // body:         {sort.apply(rows).map(...)}
 *
 * Editing keeps working because rows are keyed by id, not position — sorting only
 * reorders what's shown. Blanks always sort last. Third click clears the sort.
 */
type Getter<T> = (row: T) => string | number | null | undefined;

export function useColumnSort<T>() {
  const [sort, setSort] = useState<{ key: string; dir: 'asc' | 'desc'; get: Getter<T> } | null>(null);

  const toggle = (key: string, get: Getter<T>) =>
    setSort((cur) =>
      !cur || cur.key !== key
        ? { key, dir: 'asc', get }
        : cur.dir === 'asc'
          ? { key, dir: 'desc', get }
          : null,
    );

  function apply(rows: T[]): T[] {
    if (!sort) return rows;
    const dir = sort.dir === 'asc' ? 1 : -1;
    return [...rows].sort((a, b) => {
      const av = sort.get(a);
      const bv = sort.get(b);
      const ae = av === null || av === undefined || av === '';
      const be = bv === null || bv === undefined || bv === '';
      if (ae && be) return 0;
      if (ae) return 1; // blanks last regardless of direction
      if (be) return -1;
      if (typeof av === 'number' && typeof bv === 'number') return (av - bv) * dir;
      return String(av).localeCompare(String(bv), undefined, { numeric: true }) * dir;
    });
  }

  /** Indicator node for a header (faint ↕, or ▲/▼ when active). */
  function ind(key: string): ReactNode {
    const on = sort?.key === key;
    return (
      <span className={`wf-sort-ind${on ? ' is-active' : ''}`} aria-hidden="true">
        {on ? (sort!.dir === 'asc' ? '▲' : '▼') : '↕'}
      </span>
    );
  }

  /** Spread onto a <th> to make it sort by `get` on click. */
  function th(key: string, get: Getter<T>) {
    return {
      onClick: () => toggle(key, get),
      style: { cursor: 'pointer' as const, whiteSpace: 'nowrap' as const },
      title: 'Click to sort',
    };
  }

  return { apply, ind, th, sort };
}
