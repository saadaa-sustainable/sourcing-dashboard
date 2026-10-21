'use client';



import { useCallback, useEffect, useMemo, useState } from 'react';

import Link from 'next/link';

import { useRouter } from 'next/navigation';

import { Search, ChevronDown } from 'lucide-react';

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

  const boardOpened = openId ? data.cards.find((c) => c.id === openId) : undefined;
  const overviewPool = data.overviewCards ?? data.cards;
  // Consolidated month cards open FG by default, or Material if FG is absent.
  const opened = openId
    ? overviewPool.find((c) => c.id === openId) ??
      (boardOpened
        ? overviewPool.find((c) => c.month === boardOpened.month && c.track === 'FG' && c.detail) ??
          overviewPool.find((c) => c.month === boardOpened.month && c.detail) ?? boardOpened
        : undefined)
    : undefined;
  // Previous / next month and track switch use the original track-specific cards.
  const sameTrack = opened ? overviewPool.filter((c) => (c.track ?? '') === (opened.track ?? '') && c.detail).sort((a, b) => a.month.localeCompare(b.month)) : [];
  const at = opened ? sameTrack.findIndex((c) => c.id === opened.id) : -1;
  const tracks =
    opened?.track && data.trackLabels && Object.keys(data.trackLabels).length > 1
      ? Object.entries(data.trackLabels).map(([t, label]) => ({
          track: t,
          label,
          card: overviewPool.find((c) => c.month === opened.month && c.track === t && c.detail),
        }))
      : undefined;

  // Hide the legacy "No Updates" status from the monthly board. Months that have
  // no updates should be grouped with "Partially Updated" instead.
  const noUpdatesColumn = data.columns.find(
    (c) => c.key === 'back' || c.label.trim().toLowerCase() === 'no updates',
  );
  const partiallyUpdatedColumn = data.columns.find(
    (c) => c.key === 'pending' || c.label.trim().toLowerCase() === 'partially updated',
  );
  const visibleColumns = data.columns.filter((c) => c.key !== noUpdatesColumn?.key);
  const displayStatus = useCallback(
    (status: string) =>
      noUpdatesColumn && partiallyUpdatedColumn && status === noUpdatesColumn.key
        ? partiallyUpdatedColumn.key
        : status,
    [noUpdatesColumn?.key, partiallyUpdatedColumn?.key],
  );

  const shown = useMemo(() => {

    const q = query.trim().toLowerCase();

    return data.cards

      .filter((c) => (filter === 'all' || displayStatus(c.status) === filter) && (!q || `${c.label} ${c.track ?? ''}`.toLowerCase().includes(q)))

      .sort((a, b) => b.month.localeCompare(a.month) || (a.track ?? '').localeCompare(b.track ?? ''));

  }, [data.cards, filter, query, displayStatus]);



  const noun = data.noun ?? 'month';

  const Noun = noun.charAt(0).toUpperCase() + noun.slice(1);



  const cols = filter === 'all' ? visibleColumns : visibleColumns.filter((c) => c.key === filter);

  const colOf = (key: string) => visibleColumns.find((c) => c.key === displayStatus(key));



  return (

    <div className="mb">

      {data.totals.length > 0 && (

        <div className="mb-statusrow">

          <div className="mb-totals" style={{ marginLeft: 'auto' }}>

            {data.totals.map((t) => (

              <div key={t.label}>

                <b>{t.value}</b>

                <span>{t.label}</span>

              </div>

            ))}

          </div>

        </div>

      )}



      <div className="tb">

        <div className="tb-find" style={{ margin: '0px' }}>

          <div className="segment" role="group" aria-label="Filter by status">

            <button type="button" className={filter === 'all' ? 'active' : ''} aria-pressed={filter === 'all'} onClick={() => setFilter('all')}>

              All <span className="mb-pill-n">{data.cards.length}</span>

            </button>

            {visibleColumns.map((c) => (

              <button key={c.key} type="button" className={filter === c.key ? 'active' : ''} aria-pressed={filter === c.key} onClick={() => setFilter(c.key)}>

                <span className={`mb-dot mb-t-${c.tone}`} aria-hidden="true" />

                {c.label} <span className="mb-pill-n">{data.cards.filter((x) => x.status === c.key).length}</span>

              </button>

            ))}

          </div>

          <label className="mb-search tb-search-wrap">

            <Search size={15} aria-hidden="true" />

            <input type="search" value={query} onChange={(e) => setQuery(e.target.value)} placeholder={searchPlaceholder} aria-label={searchPlaceholder} />

          </label>



        </div>

        <div className="tb-see">

          <label className="mb-view-control">

            <span>View: </span>

            <select className="mb-view-select" value={view} onChange={(e) => setView(e.target.value as View)} aria-label="Choose board view">

              <option value="kanban">Kanban</option>

              <option value="cards">Cards</option>

              <option value="list">List</option>

            </select>

            <ChevronDown size={14} aria-hidden="true" />

          </label>

          {pageBar && (

            <>

              <span className="tb-divider" />

              {pageBar}

            </>

          )}

        </div>

      </div>



      {view === 'kanban' ? (

        <div className="mb-kanban" style={{ ['--mb-cols' as string]: cols.length }}>

          {cols.map((col) => {

            const items = shown.filter((c) => displayStatus(c.status) === col.key);

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

                {items.map((c) => <Card key={c.id} card={c} col={colOf(c.status)} onOpen={openCard} follow={data.cardClick === 'open'} />)}

                {!items.length && <p className="mb-empty">Nothing here.</p>}

              </section>

            );

          })}

        </div>

      ) : view === 'cards' ? (

        <div className="mb-grid">

          {shown.map((c) => <Card key={c.id} card={c} col={colOf(c.status)} onOpen={openCard} follow={data.cardClick === 'open'} />)}

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

          tracks={tracks}

          onNavigate={openCard}

          onClose={closeCard}

        />

      )}

    </div>

  );

}



function Card({ card: c, col, onOpen, follow = false }: { card: MonthBoardCard; col?: MonthBoardColumn; onOpen: (id: string) => void; follow?: boolean }) {

  const router = useRouter();

  // Clicking anywhere on the card opens the month's overview (the Overview button is the

  // keyboard route), or with `follow` goes to its primary action's screen; its buttons and

  // links keep their own job.

  const target = follow ? (c.actions.find((a) => a.primary) ?? c.actions[0])?.href : undefined;

  const clickable = Boolean(target || c.detail);

  const open = (e: React.MouseEvent) => {

    if (!clickable || (e.target as HTMLElement).closest('a, button')) return;

    if (target) router.push(target);

    else onOpen(c.id);

  };

  return (

    <article className={`mb-card${clickable ? ' is-clickable' : ''}`} onClick={open}>

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
      {c.trackProgress?.map((p) => (
        <div className="mb-prog" key={p.label}>
          <div className="mb-prog-row">
            <strong>{p.label}</strong>
            <span>{p.right}</span>
          </div>
          <div className="mb-prog-row"><span>{p.left}</span></div>
          {p.pct != null ? (
            <div className={`mb-bar${p.over ? ' is-over' : ''}`}>
              <i style={{ width: `${Math.max(0, Math.min(100, p.pct))}%` }} />
            </div>
          ) : (
            <small className="mb-progress-unavailable">Progress not available yet</small>
          )}
        </div>
      ))}

      {c.facts.length > 0 && (

        <ul className="mb-facts">

          {c.facts.map((f) => <li key={f}>{f}</li>)}

        </ul>

      )}

      {c.warn && <p className={`mb-warn mb-t-${c.warn.tone}`}>{c.warn.text}</p>}

      <div className="mb-actions">

        {c.id.startsWith('bp-month-') ? (
          <>
            {c.actions.filter((a) => a.label === 'Open').map((a) => (
              <Link key={a.label} href={a.href} className={`wf-btn wf-btn-sm ${a.primary ? 'wf-btn-primary' : 'wf-btn-ghost'}`}>
                Open
              </Link>
            ))}
            {c.detail && (
              <button type="button" className="wf-btn wf-btn-sm wf-btn-ghost" onClick={() => onOpen(c.id)}>
                Overview
              </button>
            )}
            {c.actions.filter((a) => a.label !== 'Open').map((a) => (
              <Link key={a.label} href={a.href} className={`wf-btn wf-btn-sm ${a.primary ? 'wf-btn-primary' : 'wf-btn-ghost'}`}>
                {a.label}
              </Link>
            ))}
          </>
        ) : (
          <>
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
          </>
        )}

      </div>

    </article>

  );

}
