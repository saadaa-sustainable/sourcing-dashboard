'use client';

import { useState, useSyncExternalStore, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { Columns3, LayoutGrid, Table2, X } from 'lucide-react';

export type CardTone = 'green' | 'yellow' | 'red' | 'gray' | 'blue' | 'violet';

/** One plan line, already worked out by the page, in the shape the card views need. */
export type PlanCard = {
  key: string;
  code: string;
  status: { text: string; tone: CardTone };
  context: string;
  /** Quantities side by side (Job / E-FOB / FOB, or Job Work / Purchase). */
  figs: { label: string; value: string | null }[];
  value: number | null;
  /** e.g. "1,122 pcs · 4.2% of plan" */
  valueNote: string;
  progress?: { text: string; pct: number };
  rates: string;
  tags: { text: string; kind?: 'npd' | 'nocost' | 'over' }[];
  details: [string, string][];
  sort: { value: number; qty: number; pct: number };
  /** Kanban column key for each column option. */
  groups: Record<string, string>;
};

export type KanbanOption = {
  key: string;
  label: string;
  /** Fixed columns in order; omitted = one column per distinct value, by value. */
  columns?: { key: string; title: string; tone: CardTone }[];
};

type View = 'cards' | 'kanban' | 'table';

// The chosen view is remembered per browser (a convenience, never required).
function readView(storageKey: string): View | null {
  try {
    const v = localStorage.getItem(storageKey);
    return v === 'cards' || v === 'kanban' || v === 'table' ? v : null;
  } catch {
    return null;
  }
}
const listeners = new Set<() => void>();
function subscribe(fn: () => void) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

function inr(v: number) {
  const abs = Math.abs(v);
  if (abs >= 1e7) return `₹${(v / 1e7).toFixed(2)} Cr`;
  if (abs >= 1e5) return `₹${(v / 1e5).toFixed(2)} L`;
  return `₹${new Intl.NumberFormat('en-IN', { maximumFractionDigits: 0 }).format(v)}`;
}

const TONE_DOT: Record<CardTone, string> = {
  green: 'var(--success-border, #3d9e6b)',
  yellow: '#d89b00',
  red: 'var(--danger-text, #c0392b)',
  gray: 'var(--ink-4, #9a9384)',
  blue: '#2463a8',
  violet: '#5c4dd4',
};

/**
 * Plan detail as Cards, Kanban or Table (same lines, same filters). Cards follow the
 * Standard Cost product card; Kanban groups them into columns by a chosen field; Table is
 * the page's existing sheet. A card opens a side panel with the line's figures and, for an
 * approver, the per-line decision.
 */
export function PlanLineViews({
  items,
  table,
  kanban,
  decision,
  storageKey,
  noun = 'line',
  qtyUnit = 'pcs',
  defaultView = 'cards',
}: {
  items: PlanCard[];
  table: ReactNode;
  kanban: KanbanOption[];
  decision?: (key: string) => ReactNode;
  storageKey: string;
  noun?: string;
  /** Unit for kanban column totals; null when quantities are in mixed units. */
  qtyUnit?: string | null;
  defaultView?: View;
}) {
  const view = useSyncExternalStore(
    subscribe,
    () => readView(storageKey) ?? defaultView,
    () => defaultView,
  );
  const setView = (v: View) => {
    try {
      localStorage.setItem(storageKey, v);
    } catch {
      /* private window: the switch still works for this render */
    }
    listeners.forEach((fn) => fn());
  };
  const [by, setBy] = useState(kanban[0]?.key ?? '');
  const [sort, setSort] = useState<'value' | 'qty' | 'pct' | 'code'>('value');
  const [open, setOpen] = useState<string | null>(null);

  const sorted = [...items].sort((a, b) =>
    sort === 'qty'
      ? b.sort.qty - a.sort.qty
      : sort === 'pct'
        ? a.sort.pct - b.sort.pct || b.sort.value - a.sort.value
        : sort === 'code'
          ? a.code.localeCompare(b.code)
          : b.sort.value - a.sort.value,
  );
  const option = kanban.find((k) => k.key === by) ?? kanban[0];
  const columns =
    option?.columns ??
    [...new Set(sorted.map((i) => i.groups[option?.key ?? ''] ?? '—'))]
      .map((k) => ({ key: k, title: k, tone: 'gray' as CardTone }))
      .sort(
        (a, b) =>
          sorted.filter((i) => i.groups[option.key] === b.key).reduce((s, i) => s + (i.value ?? 0), 0) -
          sorted.filter((i) => i.groups[option.key] === a.key).reduce((s, i) => s + (i.value ?? 0), 0),
      );
  const openItem = open ? items.find((i) => i.key === open) ?? null : null;
  const fmt = new Intl.NumberFormat('en-IN', { maximumFractionDigits: 0 });

  const card = (it: PlanCard, compact = false) => (
    <article
      key={it.key}
      className={`pl-card${compact ? ' compact' : ''}`}
      tabIndex={0}
      role="button"
      aria-label={`${it.code}, open line details`}
      onClick={() => setOpen(it.key)}
      onKeyDown={(e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          setOpen(it.key);
        }
      }}
    >
      <div className="pl-card-head">
        <span className="mono pl-card-code">{it.code}</span>
        <span className={`bp-badge ${it.status.tone}`}>{it.status.text}</span>
      </div>
      <div className="pl-card-ctx">{it.context}</div>
      <div className="pl-card-figs" style={{ gridTemplateColumns: `repeat(${it.figs.length}, minmax(0, 1fr))` }}>
        {it.figs.map((f) => (
          <div key={f.label}>
            <span>{f.label}</span>
            <strong className={f.value ? '' : 'muted'}>{f.value ?? '—'}</strong>
          </div>
        ))}
      </div>
      <div className="pl-card-money">
        <b>{it.value ? inr(it.value) : '—'}</b>
        <small>{it.valueNote}</small>
      </div>
      {it.progress && (
        <div className="pl-card-prog">
          <div className="bp-progress m0"><span style={{ width: `${it.progress.pct}%` }} /></div>
          <small><span>{it.progress.text}</span><span>{it.progress.pct}%</span></small>
        </div>
      )}
      <div className="pl-card-foot">
        <span className="pl-card-link">Line details</span>
        <span className="pl-card-rates" title="Approved standard cost, ₹ per unit">{it.rates}</span>
      </div>
      {it.tags.length > 0 && (
        <div className="pl-card-tags">
          {it.tags.map((t) => (
            <span key={t.text} className={`pl-tag${t.kind ? ` ${t.kind}` : ''}`}>{t.text}</span>
          ))}
        </div>
      )}
    </article>
  );

  return (
    <>
      <div className="pl-views-bar">
        <div className="segment wf-segment" role="group" aria-label="View lines as">
          <button type="button" className={view === 'cards' ? 'active' : ''} aria-pressed={view === 'cards'} onClick={() => setView('cards')}>
            <LayoutGrid size={14} aria-hidden="true" /> Cards
          </button>
          <button type="button" className={view === 'kanban' ? 'active' : ''} aria-pressed={view === 'kanban'} onClick={() => setView('kanban')}>
            <Columns3 size={14} aria-hidden="true" /> Kanban
          </button>
          <button type="button" className={view === 'table' ? 'active' : ''} aria-pressed={view === 'table'} onClick={() => setView('table')}>
            <Table2 size={14} aria-hidden="true" /> Table
          </button>
        </div>
        {view === 'kanban' && kanban.length > 1 && (
          <select aria-label="Kanban columns" value={option?.key} onChange={(e) => setBy(e.target.value)}>
            {kanban.map((k) => (
              <option key={k.key} value={k.key}>Columns: {k.label}</option>
            ))}
          </select>
        )}
        {view !== 'table' && (
          <select aria-label="Sort" value={sort} onChange={(e) => setSort(e.target.value as typeof sort)}>
            <option value="value">Sort: Plan value (high first)</option>
            <option value="qty">Sort: Plan qty (high first)</option>
            {items.some((i) => i.progress) && <option value="pct">Sort: Bought % (low first)</option>}
            <option value="code">Sort: Code</option>
          </select>
        )}
      </div>

      {view === 'table' ? (
        table
      ) : view === 'cards' ? (
        <div className="pl-cards">
          {sorted.map((it) => card(it))}
          {!sorted.length && <p className="wf-empty-cell">No {noun}s match the filters.</p>}
        </div>
      ) : (
        <div className="pl-kanban">
          {columns.map((c) => {
            const colItems = sorted.filter((i) => (i.groups[option.key] ?? '—') === c.key);
            const value = colItems.reduce((s, i) => s + (i.value ?? 0), 0);
            const qty = colItems.reduce((s, i) => s + i.sort.qty, 0);
            return (
              <section className="pl-col" key={c.key} aria-label={c.title}>
                <div className="pl-col-head">
                  <div className="pl-col-title">
                    <span><i style={{ background: TONE_DOT[c.tone] }} aria-hidden="true" />{c.title}</span>
                    <span className="bp-badge gray">{colItems.length}</span>
                  </div>
                  <small>{value ? inr(value) : '—'}{qtyUnit ? ` · ${fmt.format(qty)} ${qtyUnit}` : ''}</small>
                </div>
                <div className="pl-col-body">
                  {colItems.length ? colItems.map((it) => card(it, true)) : <div className="pl-col-empty">None</div>}
                </div>
              </section>
            );
          })}
        </div>
      )}

      {openItem && typeof document !== 'undefined' &&
        createPortal(
          <div className="pl-drawer-layer" onKeyDown={(e) => { if (e.key === 'Escape') setOpen(null); }}>
            <button type="button" className="pl-scrim" aria-label="Close line details" onClick={() => setOpen(null)} />
            <aside className="pl-drawer" role="dialog" aria-modal="true" aria-labelledby="pl-drawer-title">
              <div className="pl-drawer-head">
                <h3 id="pl-drawer-title" className="mono">{openItem.code}</h3>
                <button type="button" className="pl-x" autoFocus aria-label="Close" onClick={() => setOpen(null)}>
                  <X size={18} />
                </button>
              </div>
              <div className="pl-drawer-body">
                <div className="pl-card-tags">
                  <span className={`bp-badge ${openItem.status.tone}`}>{openItem.status.text}</span>
                  {openItem.tags.map((t) => (
                    <span key={t.text} className={`pl-tag${t.kind ? ` ${t.kind}` : ''}`}>{t.text}</span>
                  ))}
                </div>
                <div className="pl-card-figs" style={{ gridTemplateColumns: `repeat(${openItem.figs.length}, minmax(0, 1fr))` }}>
                  {openItem.figs.map((f) => (
                    <div key={f.label}><span>{f.label}</span><strong className={f.value ? '' : 'muted'}>{f.value ?? '—'}</strong></div>
                  ))}
                </div>
                <dl className="pl-kv">
                  {openItem.details.map(([k, v]) => (
                    <div key={k}><dt>{k}</dt><dd>{v}</dd></div>
                  ))}
                </dl>
                {openItem.progress && (
                  <div className="pl-card-prog">
                    <div className="bp-progress m0"><span style={{ width: `${openItem.progress.pct}%` }} /></div>
                    <small><span>{openItem.progress.text}</span><span>{openItem.progress.pct}%</span></small>
                  </div>
                )}
                {decision && (
                  <div className="pl-drawer-decision">
                    <b>Your decision</b>
                    {decision(openItem.key)}
                  </div>
                )}
              </div>
            </aside>
          </div>,
          document.body,
        )}
    </>
  );
}
