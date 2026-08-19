'use client';

import { useMemo, useState, type ReactNode } from 'react';

// A reusable read-only data table with: a global search box, a per-column filter row
// (dropdown for low-cardinality columns, text/number-operator input otherwise),
// click-to-sort headers, a result count and pagination. Drop-in for the wf-grid tables.
export type Column<T> = {
  key: string;
  label: string;
  kind?: 'text' | 'mono' | 'num';
  /** Value used for search / filter / sort. Defaults to row[key]. */
  accessor?: (row: T) => string | number | null | undefined;
  /** Custom cell render. Defaults to the formatted value (or “—”). */
  render?: (row: T) => ReactNode;
  /** Force a filter style; default auto (select if ≤20 distinct, else text). */
  filter?: 'auto' | 'select' | 'text' | 'none';
  sortable?: boolean;
};

const fmt = new Intl.NumberFormat('en-IN', { maximumFractionDigits: 2 });

function raw<T>(row: T, col: Column<T>): string | number | null | undefined {
  if (col.accessor) return col.accessor(row);
  return (row as Record<string, unknown>)[col.key] as string | number | null | undefined;
}
const asText = (v: unknown) => (v === null || v === undefined ? '' : String(v));

function defaultCell<T>(row: T, col: Column<T>): ReactNode {
  const v = raw(row, col);
  if (v === null || v === undefined || v === '') return <span className="wf-subtle">—</span>;
  if (col.kind === 'num') return fmt.format(Number(v));
  return String(v);
}

export function FilterTable<T>({
  rows,
  columns,
  rowKey,
  rowClass,
  pageSize = 50,
  searchPlaceholder = 'Search…',
  emptyText = 'No rows.',
  unit = 'rows',
  toolbarExtra,
}: {
  rows: T[];
  columns: Column<T>[];
  rowKey: (row: T, index: number) => string;
  rowClass?: (row: T) => string | undefined;
  pageSize?: number;
  searchPlaceholder?: string;
  emptyText?: string;
  unit?: string;
  toolbarExtra?: ReactNode;
}) {
  const [search, setSearch] = useState('');
  const [colFilters, setColFilters] = useState<Record<string, string>>({});
  const [sort, setSort] = useState<{ key: string; dir: 'asc' | 'desc' } | null>(null);
  const [page, setPage] = useState(0);

  // Resolve each column's filter style + dropdown options once per data/columns change.
  const meta = useMemo(
    () =>
      columns.map((col) => {
        let mode: 'select' | 'text' | 'none' =
          col.filter && col.filter !== 'auto' ? col.filter : 'text';
        if (!col.filter || col.filter === 'auto') {
          if (col.kind === 'num') mode = 'text';
          else {
            const distinct = new Set<string>();
            for (const r of rows) {
              const t = asText(raw(r, col)).trim();
              if (t) distinct.add(t);
              if (distinct.size > 20) break;
            }
            mode = distinct.size > 0 && distinct.size <= 20 ? 'select' : 'text';
          }
        }
        const options =
          mode === 'select'
            ? [...new Set(rows.map((r) => asText(raw(r, col)).trim()).filter(Boolean))].sort(
                (a, b) => a.localeCompare(b, undefined, { numeric: true }),
              )
            : [];
        return { col, mode, options };
      }),
    [columns, rows],
  );

  const filtered = useMemo(() => {
    const s = search.trim().toLowerCase();
    return rows.filter((r) => {
      if (s && !columns.some((c) => asText(raw(r, c)).toLowerCase().includes(s))) return false;
      for (const { col, mode } of meta) {
        const f = colFilters[col.key];
        if (!f) continue;
        const v = raw(r, col);
        if (mode === 'select') {
          if (asText(v).trim() !== f) return false;
        } else if (col.kind === 'num') {
          const m = f.match(/^\s*(>=|<=|>|<|=)?\s*(-?\d[\d.,]*)\s*$/);
          if (m) {
            const num = Number(asText(v).replace(/,/g, ''));
            const target = Number(m[2].replace(/,/g, ''));
            if (Number.isNaN(num)) return false;
            const op = m[1] || '=';
            if (op === '>=' && !(num >= target)) return false;
            if (op === '<=' && !(num <= target)) return false;
            if (op === '>' && !(num > target)) return false;
            if (op === '<' && !(num < target)) return false;
            if (op === '=' && num !== target) return false;
          } else if (!asText(v).toLowerCase().includes(f.toLowerCase())) return false;
        } else if (!asText(v).toLowerCase().includes(f.toLowerCase())) return false;
      }
      return true;
    });
  }, [rows, columns, meta, colFilters, search]);

  const sorted = useMemo(() => {
    if (!sort) return filtered;
    const col = columns.find((c) => c.key === sort.key);
    if (!col) return filtered;
    const dir = sort.dir === 'asc' ? 1 : -1;
    const isNum = col.kind === 'num';
    return [...filtered].sort((a, b) => {
      const av = raw(a, col);
      const bv = raw(b, col);
      const ae = av === null || av === undefined || av === '';
      const be = bv === null || bv === undefined || bv === '';
      if (ae && be) return 0;
      if (ae) return 1; // blanks last, regardless of direction
      if (be) return -1;
      if (isNum) return (Number(av) - Number(bv)) * dir;
      return asText(av).localeCompare(asText(bv), undefined, { numeric: true }) * dir;
    });
  }, [filtered, sort, columns]);

  const pageCount = Math.max(1, Math.ceil(sorted.length / pageSize));
  const p = Math.min(page, pageCount - 1);
  const pageRows = sorted.slice(p * pageSize, p * pageSize + pageSize);
  const anyFilter = Boolean(search) || Object.values(colFilters).some(Boolean) || Boolean(sort);

  function toggleSort(key: string) {
    setSort((cur) => {
      if (!cur || cur.key !== key) return { key, dir: 'asc' };
      return cur.dir === 'asc' ? { key, dir: 'desc' } : null;
    });
    setPage(0);
  }
  function setFilter(key: string, value: string) {
    setColFilters((f) => ({ ...f, [key]: value }));
    setPage(0);
  }

  return (
    <>
      <div className="wf-toolbar">
        <div className="wf-toolbar-left">
          <label className="field">
            <span>Search</span>
            <input
              placeholder={searchPlaceholder}
              value={search}
              onChange={(e) => { setSearch(e.target.value); setPage(0); }}
            />
          </label>
          {toolbarExtra}
          {anyFilter && (
            <button
              type="button"
              className="wf-btn wf-btn-ghost"
              onClick={() => { setSearch(''); setColFilters({}); setSort(null); setPage(0); }}
            >
              Clear filters
            </button>
          )}
        </div>
        <div className="wf-chip">{fmt.format(sorted.length)} {unit}</div>
      </div>

      <div className="table-panel wf-grid-panel">
        <div className="table-scroll">
          <table className="wf-grid">
            <thead>
              <tr>
                {meta.map(({ col }) => {
                  const sortable = col.sortable !== false;
                  const active = sort?.key === col.key;
                  return (
                    <th
                      key={col.key}
                      className={col.kind === 'num' ? 'num' : undefined}
                      style={sortable ? { cursor: 'pointer', whiteSpace: 'nowrap' } : undefined}
                      onClick={sortable ? () => toggleSort(col.key) : undefined}
                      title={sortable ? 'Click to sort' : undefined}
                    >
                      {col.label}
                      {active ? (sort!.dir === 'asc' ? ' ▲' : ' ▼') : ''}
                    </th>
                  );
                })}
              </tr>
              <tr>
                {meta.map(({ col, mode, options }) => (
                  <th key={col.key} style={{ padding: '2px 6px' }}>
                    {mode === 'none' ? null : mode === 'select' ? (
                      <select
                        style={{ width: '100%', fontWeight: 400, fontSize: 12 }}
                        value={colFilters[col.key] ?? ''}
                        onChange={(e) => setFilter(col.key, e.target.value)}
                      >
                        <option value="">All</option>
                        {options.map((o) => <option key={o} value={o}>{o}</option>)}
                      </select>
                    ) : (
                      <input
                        style={{ width: '100%', fontWeight: 400, fontSize: 12 }}
                        placeholder={col.kind === 'num' ? 'e.g. >100' : 'filter'}
                        value={colFilters[col.key] ?? ''}
                        onChange={(e) => setFilter(col.key, e.target.value)}
                      />
                    )}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {pageRows.map((row, i) => (
                <tr key={rowKey(row, p * pageSize + i)} className={rowClass?.(row)}>
                  {columns.map((col) => (
                    <td
                      key={col.key}
                      className={col.kind === 'num' ? 'num' : col.kind === 'mono' ? 'mono' : undefined}
                    >
                      {col.render ? col.render(row) : defaultCell(row, col)}
                    </td>
                  ))}
                </tr>
              ))}
              {!sorted.length && (
                <tr>
                  <td colSpan={columns.length} className="wf-empty-cell">{emptyText}</td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
        {pageCount > 1 && (
          <div className="pager">
            <button type="button" disabled={p <= 0} onClick={() => setPage(p - 1)}>Prev</button>
            <span>Page {p + 1} of {pageCount} · {fmt.format(sorted.length)} {unit}</span>
            <button type="button" disabled={p >= pageCount - 1} onClick={() => setPage(p + 1)}>Next</button>
          </div>
        )}
      </div>
    </>
  );
}
