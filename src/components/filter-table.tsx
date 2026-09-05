'use client';

import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { Download, ListFilter } from 'lucide-react';
import { InfoDot } from '@/components/info-dot';
import { downloadCsv } from '@/lib/download';

// A reusable read-only data table with: a global search box, a per-column filter row
// (multi-select checkbox dropdown for low-cardinality columns, text/number-operator
// input otherwise), click-to-sort headers, a result count and pagination.
// Drop-in for the wf-grid tables.
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
  /** Optional ⓘ help shown next to the header label. */
  info?: string;
};

const fmt = new Intl.NumberFormat('en-IN', { maximumFractionDigits: 2 });

/** Sentinel option meaning “cell is blank” — shown as “—” in the dropdown. */
export const BLANK = '\u0000blank';

// Checkbox dropdown used as the column filter for low-cardinality columns.
// The panel is position:fixed (anchored to the trigger) so the table's scroll
// container can't clip it; any scroll or outside click closes it.
function MultiSelectFilter({
  options,
  value,
  onChange,
}: {
  options: string[];
  value: string[];
  onChange: (next: string[]) => void;
}) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [pos, setPos] = useState<{ top: number; left: number; width: number } | null>(null);
  const rootRef = useRef<HTMLDivElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const close = (e: Event) => {
      const t = e.target as Node;
      if (rootRef.current?.contains(t) || panelRef.current?.contains(t)) return;
      setOpen(false);
    };
    const onScroll = (e: Event) => {
      if (panelRef.current?.contains(e.target as Node)) return;
      setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setOpen(false); };
    document.addEventListener('mousedown', close);
    window.addEventListener('scroll', onScroll, true);
    window.addEventListener('resize', onScroll);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', close);
      window.removeEventListener('scroll', onScroll, true);
      window.removeEventListener('resize', onScroll);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);

  const toggle = (opt: string) =>
    onChange(value.includes(opt) ? value.filter((v) => v !== opt) : [...value, opt]);

  // With many options a plain checkbox list is unusable — add a search box.
  const searchable = options.length > 15;
  const q = query.trim().toLowerCase();
  const shown = q ? options.filter((o) => o.toLowerCase().includes(q)) : options;

  const label =
    value.length === 0 ? 'All' : value.length === 1 ? (value[0] === BLANK ? '—' : value[0]) : `${value.length} selected`;

  return (
    <div ref={rootRef}>
      <button
        type="button"
        style={{
          width: '100%',
          padding: '2px 6px',
          textAlign: 'left',
          fontWeight: value.length ? 600 : 400,
          fontSize: 12,
          background: '#fff',
          border: '1px solid var(--line-strong, #c9c2ae)',
          borderRadius: 6,
          cursor: 'pointer',
          overflow: 'hidden',
          textOverflow: 'ellipsis',
          whiteSpace: 'nowrap',
        }}
        title={label}
        onClick={(e) => {
          const r = e.currentTarget.getBoundingClientRect();
          setPos({ top: r.bottom + 2, left: r.left, width: Math.max(r.width, 160) });
          setQuery('');
          setOpen((o) => !o);
        }}
      >
        {label} ▾
      </button>
      {open && pos && (
        <div
          ref={panelRef}
          style={{
            position: 'fixed',
            top: pos.top,
            left: Math.min(pos.left, Math.max(0, window.innerWidth - pos.width - 8)),
            minWidth: pos.width,
            maxWidth: 320,
            maxHeight: 260,
            overflowY: 'auto',
            zIndex: 60,
            padding: 4,
            background: '#fff',
            border: '1px solid var(--line-strong, #c9c2ae)',
            borderRadius: 8,
            boxShadow: '0 10px 28px rgba(34,40,74,.18)',
            fontWeight: 400,
            fontSize: 12,
          }}
        >
          {searchable && (
            <input
              autoFocus
              placeholder="Search…"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              style={{
                width: '100%',
                padding: '3px 6px',
                marginBottom: 2,
                fontSize: 12,
                fontWeight: 400,
                border: '1px solid var(--line, #e7e2d2)',
                borderRadius: 6,
              }}
            />
          )}
          <button
            type="button"
            style={{
              width: '100%',
              padding: '3px 6px',
              textAlign: 'left',
              fontSize: 12,
              color: value.length ? 'var(--accent-strong, #a8870d)' : 'inherit',
              background: 'transparent',
              border: 0,
              borderBottom: '1px solid var(--line, #e7e2d2)',
              cursor: 'pointer',
            }}
            onClick={() => onChange([])}
          >
            All (clear)
          </button>
          {(q ? shown : [BLANK, ...shown]).map((o) => (
            <label
              key={o}
              style={{ display: 'flex', alignItems: 'center', gap: 6, padding: '3px 6px', cursor: 'pointer' }}
            >
              <input type="checkbox" checked={value.includes(o)} onChange={() => toggle(o)} />
              <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                {o === BLANK ? '—' : o}
              </span>
            </label>
          ))}
        </div>
      )}
    </div>
  );
}

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
  download,
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
  /** Adds a CSV button exporting the CURRENT view — filtered + sorted rows, all columns. */
  download?: { filename: string };
}) {
  const [search, setSearch] = useState('');
  const [colFilters, setColFilters] = useState<Record<string, string>>({});
  const [selFilters, setSelFilters] = useState<Record<string, string[]>>({});
  const [sort, setSort] = useState<{ key: string; dir: 'asc' | 'desc' } | null>(null);
  const [page, setPage] = useState(0);
  // Per-column filter boxes are OFF by default — a clean table + one Search box is
  // less intimidating. Users who want column-by-column filtering turn it on.
  const [showColFilters, setShowColFilters] = useState(false);

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
        const v = raw(r, col);
        if (mode === 'select') {
          const sel = selFilters[col.key];
          if (!sel?.length) continue;
          const t = asText(v).trim();
          if (!sel.includes(t === '' ? BLANK : t)) return false;
          continue;
        }
        const f = colFilters[col.key];
        if (!f) continue;
        if (col.kind === 'num') {
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
  }, [rows, columns, meta, colFilters, selFilters, search]);

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
  const anyFilter =
    Boolean(search) ||
    Object.values(colFilters).some(Boolean) ||
    Object.values(selFilters).some((s) => s.length > 0) ||
    Boolean(sort);
  const activeColCount =
    Object.values(colFilters).filter(Boolean).length +
    Object.values(selFilters).filter((s) => s.length > 0).length;

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
  function setSelFilter(key: string, value: string[]) {
    setSelFilters((f) => ({ ...f, [key]: value }));
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
          <button
            type="button"
            className={`wf-btn wf-btn-ghost${showColFilters || activeColCount ? ' is-active' : ''}`}
            aria-pressed={showColFilters}
            title="Show a filter box under each column heading"
            onClick={() => setShowColFilters((v) => !v)}
          >
            <ListFilter size={13} /> Filter columns{activeColCount ? ` (${activeColCount})` : ''}
          </button>
          {toolbarExtra}
          {download && (
            <button
              type="button"
              className="download-button"
              title="Download the rows you're seeing (as a .csv file)"
              onClick={() =>
                downloadCsv(
                  download.filename,
                  columns.map((c) => c.label),
                  sorted.map((r) => columns.map((c) => asText(raw(r, c)))),
                )
              }
            >
              <Download size={13} /> Download
            </button>
          )}
          {anyFilter && (
            <button
              type="button"
              className="wf-btn wf-btn-ghost"
              onClick={() => { setSearch(''); setColFilters({}); setSelFilters({}); setSort(null); setPage(0); }}
            >
              Clear filters
            </button>
          )}
        </div>
        <div className="wf-chip">{fmt.format(sorted.length)} {unit}</div>
      </div>

      <p className="wf-table-hint">
        Type in <strong>Search</strong> to find a word anywhere. Click a column heading to
        sort. To narrow one column, use <strong>Filter columns</strong>.
        <strong> Download</strong> saves the rows you&rsquo;re seeing.
      </p>

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
                      {sortable && (
                        <span className={`wf-sort-ind${active ? ' is-active' : ''}`} aria-hidden="true">
                          {active ? (sort!.dir === 'asc' ? '▲' : '▼') : '↕'}
                        </span>
                      )}
                      {col.info && <InfoDot text={col.info} label={`About ${col.label}`} />}
                    </th>
                  );
                })}
              </tr>
              {showColFilters && (
              <tr className="wf-filter-row">
                {meta.map(({ col, mode, options }) => (
                  <th key={col.key} style={{ padding: '2px 6px' }}>
                    {mode === 'none' ? null : mode === 'select' ? (
                      <MultiSelectFilter
                        options={options}
                        value={selFilters[col.key] ?? []}
                        onChange={(next) => setSelFilter(col.key, next)}
                      />
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
              )}
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
                  <td colSpan={columns.length} className="wf-empty-cell">
                    {emptyText}
                    {anyFilter && (
                      <button
                        type="button"
                        className="wf-btn wf-btn-ghost"
                        style={{ marginLeft: 8 }}
                        onClick={() => { setSearch(''); setColFilters({}); setSort(null); setPage(0); }}
                      >
                        Clear filters
                      </button>
                    )}
                  </td>
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
