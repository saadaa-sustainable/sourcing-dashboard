'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import Link from 'next/link';
import { Search } from 'lucide-react';
import type { MonthBoardCard, MonthBoardColumn, MonthBoardData } from '@/lib/month-board';
import { MonthOverview } from './month-overview';

type View = 'kanban' | 'cards' | 'list';

/**
 * The month board: one card per month, in status columns. Status pills (with counts) filter it;
 * search and sort narrow it; Kanban / Cards / List switch how it is laid out. Each card's
 * actions are links into that month's own screen.
 */
export function MonthBoard({
  data,
  searchPlaceholder = 'Search month…',
  pageBar,
}: {
  data: MonthBoardData;
  searchPlaceholder?: string;
  /** Buttons on the right of the status row (e.g. "+ Plan next month"). */
  pageBar?: React.ReactNode;
}) {
  const [view, setView] = useState<View>('kanban');
  const [filter, setFilter] = useState<string>('all');
  const [query, setQuery] = useState('');
  const [sort, setSort] = useState<'new' | 'old'>('new');
  // The open month overview, kept in the URL (?open=<card id>) so a link reopens it.
  const [openId, setOpenId] = useState<string | null>(null);
  useEffect(() => {
    const id = new URLSearchParams(window.location.search).get('open');
    // eslint-disable-next-line react-hooks/set-state-in-effect -- read once from the URL on mount
    if (id) setOpenId(id);
  }, []);
  const openCard = useCallback((id: string | null) => {
    setOpenId(id);
    const url = new URL(window.location.href);
    if (id) url.searchParams.set('open', id);
    else url.searchParams.delete('open');
    window.history.replaceState(null, '', url);
  }, []);
  const closeCard = useCallback(() => openCard(null), [openCard]);
  const opened = openId ? data.cards.find((c) => c.id === openId) : undefined;
  // Previous / next month of the same track, for the overview's arrows.
  const sameTrack = opened ? data.cards.filter((c) => (c.track ?? '') === (opened.track ?? '') && c.detail).sort((a, b) => a.month.localeCompare(b.month)) : [];
  const at = opened ? sameTrack.findIndex((c) => c.id === opened.id) : -1;

  const shown = useMemo(() => {
    const q = query.trim().toLowerCase();
    return data.cards
      .filter((c) => (filter === 'all' || c.status === filter) && (!q || `${c.label} ${c.track ?? ''}`.toLowerCase().includes(q)))
      .sort((a, b) => (sort === 'new' ? b.month.localeCompare(a.month) : a.month.localeCompare(b.month)) || (a.track ?? '').localeCompare(b.track ?? ''));
  }, [data.cards, filter, query, sort]);

  const noun = data.noun ?? 'month';
  const Noun = noun.charAt(0).toUpperCase() + noun.slice(1);

  const cols = filter === 'all' ? data.columns : data.columns.filter((c) => c.key === filter);
  const colOf = (key: string) => data.columns.find((c) => c.key === key);

  return (
    <div className="mb">
      <div className="mb-statusrow">
        <div className="mb-pills" role="group" aria-label="Filter by status">
          <button type="button" className="mb-pill" aria-pressed={filter === 'all'} onClick={() => setFilter('all')}>
            All <span className="mb-pill-n">{data.cards.length}</span>
          </button>
          {data.columns.map((c) => (
            <button key={c.key} type="button" className="mb-pill" aria-pressed={filter === c.key} onClick={() => setFilter(c.key)}>
              <span className={`mb-dot mb-t-${c.tone}`} aria-hidden="true" />
              {c.label} <span className="mb-pill-n">{data.cards.filter((x) => x.status === c.key).length}</span>
            </button>
          ))}
        </div>
        <div className="mb-totals">
          {data.totals.map((t) => (
            <div key={t.label}>
              <b>{t.value}</b>
              <span>{t.label}</span>
            </div>
          ))}
          {pageBar}
        </div>
      </div>

      <div className="mb-toolbar">
        <label className="mb-search">
          <Search size={15} aria-hidden="true" />
          <input type="search" value={query} onChange={(e) => setQuery(e.target.value)} placeholder={searchPlaceholder} aria-label={searchPlaceholder} />
        </label>
        <select value={sort} onChange={(e) => setSort(e.target.value as 'new' | 'old')} aria-label="Sort">
          <option value="new">Newest {noun} first</option>
          <option value="old">Oldest {noun} first</option>
        </select>
        <div className="segment mb-view" role="group" aria-label="View">
          {(['kanban', 'cards', 'list'] as View[]).map((v) => (
            <button key={v} type="button" className={view === v ? 'active' : ''} aria-pressed={view === v} onClick={() => setView(v)}>
              {v === 'kanban' ? 'Kanban' : v === 'cards' ? 'Cards' : 'List'}
            </button>
          ))}
        </div>
      </div>
      <p className="mb-showing">
        Showing <b>{shown.length}</b> of {data.cards.length} {data.unit}
      </p>

      {view === 'kanban' ? (
        <div className="mb-kanban" style={{ ['--mb-cols' as string]: cols.length }}>
          {cols.map((col) => {
            const items = shown.filter((c) => c.status === col.key);
            return (
              <section key={col.key} className={`mb-col mb-t-${col.tone}`} aria-label={col.label}>
                <div className="mb-col-head">
                  <b>
                    <span className={`mb-dot mb-t-${col.tone}`} aria-hidden="true" />
                    {col.label}
                  </b>
                  <span className="mb-col-n">{items.length}</span>
                </div>
                <small>{col.hint}</small>
                {items.map((c) => <Card key={c.id} card={c} col={colOf(c.status)} onOpen={openCard} />)}
                {!items.length && <p className="mb-empty">Nothing here.</p>}
              </section>
            );
          })}
        </div>
      ) : view === 'cards' ? (
        <div className="mb-grid">
          {shown.map((c) => <Card key={c.id} card={c} col={colOf(c.status)} onOpen={openCard} />)}
          {!shown.length && <p className="mb-empty">No {noun}s match.</p>}
        </div>
      ) : (
        <div className="table-scroll mb-listwrap">
          <table className="wf-grid mb-list">
            <thead>
              <tr>
                <th>{Noun}</th>
                {data.cards.some((c) => c.track) && <th>Track</th>}
                <th>Status</th>
                {data.listColumns.map((l) => (
                  <th key={l.label} className={l.num ? 'num' : undefined}>{l.label}</th>
                ))}
                <th aria-label="Open" />
              </tr>
            </thead>
            <tbody>
              {shown.map((c) => {
                const col = colOf(c.status);
                const open = c.actions.find((a) => a.primary) ?? c.actions[0];
                return (
                  <tr key={c.id}>
                    <td><b>{c.label}</b></td>
                    {data.cards.some((x) => x.track) && <td>{c.track ?? '—'}</td>}
                    <td>{col && <span className={`mb-state mb-t-${col.tone}`}>{col.label}</span>}</td>
                    {c.list.map((v, i) => (
                      <td key={i} className={data.listColumns[i]?.num ? 'num' : undefined}>{v}</td>
                    ))}
                    <td className="mb-list-actions">
                      {c.detail && (
                        <button type="button" className="wf-btn wf-btn-ghost wf-btn-sm" onClick={() => openCard(c.id)}>Overview</button>
                      )}
                      {open && <Link className="wf-btn wf-btn-ghost wf-btn-sm" href={open.href}>{open.label}</Link>}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
      {opened && (
        <MonthOverview
          card={opened}
          col={colOf(opened.status)}
          prev={at > 0 ? sameTrack[at - 1] : undefined}
          next={at >= 0 && at < sameTrack.length - 1 ? sameTrack[at + 1] : undefined}
          onNavigate={openCard}
          onClose={closeCard}
        />
      )}
    </div>
  );
}

function Card({ card: c, col, onOpen }: { card: MonthBoardCard; col?: MonthBoardColumn; onOpen: (id: string) => void }) {
  // Clicking anywhere on the card opens the month's overview (the Overview button is the
  // keyboard route); its buttons and links keep their own job.
  const open = (e: React.MouseEvent) => {
    if (!c.detail || (e.target as HTMLElement).closest('a, button')) return;
    onOpen(c.id);
  };
  return (
    <article className={`mb-card${c.detail ? ' is-clickable' : ''}`} onClick={open}>
      <div className="mb-card-top">
        <div className="mb-chips">
          {c.track && <span className="mb-chip">{c.track}</span>}
          {col && <span className={`mb-state mb-t-${col.tone}`}>{col.label}</span>}
        </div>
        <div className="mb-big">
          <b>{c.big.value}</b>
          <span>{c.big.label}</span>
        </div>
      </div>
      <h3>{c.label}</h3>
      {c.sub && <p className="mb-sub">{c.sub}</p>}
      {c.split && (
        <div className="mb-split">
          {c.split.map((s) => (
            <span key={s.label} className={`mb-state mb-t-${s.tone}`}>{s.label}</span>
          ))}
        </div>
      )}
      {c.progress && (
        <div className="mb-prog">
          <div className="mb-prog-row">
            <span>{c.progress.left}</span>
            <span>{c.progress.right}</span>
          </div>
          <div className={`mb-bar${c.progress.over ? ' is-over' : ''}`}>
            <i style={{ width: `${Math.max(0, Math.min(100, c.progress.pct))}%` }} />
          </div>
        </div>
      )}
      {c.facts.length > 0 && (
        <ul className="mb-facts">
          {c.facts.map((f) => <li key={f}>{f}</li>)}
        </ul>
      )}
      {c.warn && <p className={`mb-warn mb-t-${c.warn.tone}`}>{c.warn.text}</p>}
      <div className="mb-actions">
        {c.detail && (
          <button type="button" className="wf-btn wf-btn-sm wf-btn-ghost" onClick={() => onOpen(c.id)}>
            Overview
          </button>
        )}
        {c.actions.map((a) => (
          <Link key={a.label} href={a.href} className={`wf-btn wf-btn-sm ${a.primary ? 'wf-btn-primary' : 'wf-btn-ghost'}`}>
            {a.label}
          </Link>
        ))}
      </div>
    </article>
  );
}
