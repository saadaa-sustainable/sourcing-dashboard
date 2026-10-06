'use client';

import { useEffect, useMemo, useState } from 'react';
import { createPortal } from 'react-dom';
import Link from 'next/link';
import { ChevronLeft, ChevronRight, Search, X } from 'lucide-react';
import type { MonthBoardCard, MonthBoardColumn, MonthDetailSection } from '@/lib/month-board';

/**
 * A month's overview, opened from its board card: status and headline ring, key facts as tiles,
 * then the month's analysis (bars, tables, timeline). The card's own actions sit in the header,
 * so "Open" / "Edit" goes straight to the month's working screen. Esc or the backdrop closes it;
 * the arrows step to the previous / next month of the same track.
 */
export function MonthOverview({
  card,
  col,
  prev,
  next,
  onNavigate,
  onClose,
}: {
  card: MonthBoardCard;
  col?: MonthBoardColumn;
  prev?: MonthBoardCard;
  next?: MonthBoardCard;
  onNavigate: (id: string) => void;
  onClose: () => void;
}) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
      if (e.key === 'ArrowLeft' && prev) onNavigate(prev.id);
      if (e.key === 'ArrowRight' && next) onNavigate(next.id);
    };
    window.addEventListener('keydown', onKey);
    const overflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => {
      window.removeEventListener('keydown', onKey);
      document.body.style.overflow = overflow;
    };
  }, [onClose, onNavigate, prev, next]);

  const d = card.detail;
  return createPortal(
    <div className="mo-layer" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="mo" role="dialog" aria-modal="true" aria-label={`${d?.kicker ?? ''} ${card.label}`}>
        <header className="mo-head">
          <div className="mo-head-main">
            <div className="mb-chips">
              {d?.kicker && <span className="mb-chip">{d.kicker}</span>}
              {col && <span className={`mb-state mb-t-${col.tone}`}>{col.label}</span>}
            </div>
            <h2>{card.label}</h2>
            {d?.lede && <p>{d.lede}</p>}
          </div>
          <div className="mo-head-actions">
            {card.actions.map((a) => (
              <Link key={a.label} href={a.href} className={`wf-btn wf-btn-sm ${a.primary ? 'wf-btn-primary' : 'wf-btn-ghost'}`}>
                {a.label}
              </Link>
            ))}
            <button type="button" className="mo-x" onClick={onClose} aria-label="Close">
              <X size={16} />
            </button>
          </div>
        </header>

        <div className="mo-body">
          <div className={`mo-hero${d?.ring ? '' : ' no-ring'}`}>
            {d?.ring && <Ring ring={d.ring} />}
            <div className="mo-tiles">
              {(d?.tiles ?? []).map((t) => (
                <div key={t.label} className="mo-tile">
                  <span>{t.label}</span>
                  <b>{t.value}</b>
                </div>
              ))}
            </div>
          </div>
          {card.warn && <p className={`mb-warn mb-t-${card.warn.tone}`}>{card.warn.text}</p>}
          {(d?.sections ?? []).map((s) => <Section key={s.title} s={s} />)}
          {!d && <p className="mb-empty">No overview for this month yet.</p>}
        </div>

        <footer className="mo-foot">
          <button type="button" className="wf-btn wf-btn-ghost wf-btn-sm" disabled={!prev} onClick={() => prev && onNavigate(prev.id)}>
            <ChevronLeft size={14} /> {prev ? prev.label : 'Earlier'}
          </button>
          <span>{card.track ? `${card.track} · ` : ''}{card.label}</span>
          <button type="button" className="wf-btn wf-btn-ghost wf-btn-sm" disabled={!next} onClick={() => next && onNavigate(next.id)}>
            {next ? next.label : 'Later'} <ChevronRight size={14} />
          </button>
        </footer>
      </div>
    </div>,
    document.body,
  );
}

function Ring({ ring }: { ring: NonNullable<NonNullable<MonthBoardCard['detail']>['ring']> }) {
  const pct = Math.max(0, Math.min(100, ring.pct));
  const r = 44;
  const c = 2 * Math.PI * r;
  return (
    <div className="mo-ringcard">
      <div className={`mo-ring${ring.over ? ' is-over' : ''}`}>
        <svg viewBox="0 0 108 108" aria-hidden="true">
          <circle cx="54" cy="54" r={r} className="mo-ring-track" />
          <circle cx="54" cy="54" r={r} className="mo-ring-fill" strokeDasharray={c} strokeDashoffset={c * (1 - pct / 100)} />
        </svg>
        <div>
          <b>{ring.over ? 'Over' : `${pct}%`}</b>
          <span>{ring.label}</span>
        </div>
      </div>
      <div className="mo-ring-text">
        <small>{ring.caption}</small>
        {ring.sub && <b>{ring.sub}</b>}
        <div className={`mb-bar${ring.over ? ' is-over' : ''}`}>
          <i style={{ width: `${pct}%` }} />
        </div>
      </div>
    </div>
  );
}

function Section({ s }: { s: MonthDetailSection }) {
  return (
    <section className="mo-sec">
      <div className="mo-sec-head">
        <div>
          <h3>{s.title}</h3>
          {s.hint && <p>{s.hint}</p>}
        </div>
        {s.kind === 'table' && <span className="mb-col-n">{s.rows.length}</span>}
      </div>
      {s.kind === 'bars' ? (
        s.bars.length ? (
          <div className="mo-bars">
            {s.bars.map((b) => (
              <div key={b.label} className="mo-barrow">
                <span>{b.label}</span>
                <div className={`mb-bar mo-bar-${b.tone ?? 'live'}`}>
                  <i style={{ width: `${Math.max(0, Math.min(100, b.pct))}%` }} />
                </div>
                <b>{b.value}</b>
              </div>
            ))}
          </div>
        ) : (
          <p className="mo-empty">{s.empty ?? 'Nothing to show.'}</p>
        )
      ) : s.kind === 'table' ? (
        <TableSection s={s} />
      ) : s.events.length ? (
        <ol className="mo-timeline">
          {s.events.map((e, i) => (
            <li key={i} className={`mb-t-${e.tone ?? 'closed'}`}>
              <span className="mo-tl-dot" aria-hidden="true" />
              <div>
                <b>{e.what}</b> <small>{e.when}</small>
                {e.note && <p>{e.note}</p>}
              </div>
            </li>
          ))}
        </ol>
      ) : (
        <p className="mo-empty">{s.empty ?? 'Nothing recorded.'}</p>
      )}
    </section>
  );
}

function TableSection({ s }: { s: Extract<MonthDetailSection, { kind: 'table' }> }) {
  const [q, setQ] = useState('');
  const [tone, setTone] = useState<string>('all');
  const rows = useMemo(() => {
    const t = q.trim().toLowerCase();
    return s.rows.filter((r) => (tone === 'all' || r.tone === tone) && (!t || r.cells.join(' ').toLowerCase().includes(t)));
  }, [s.rows, q, tone]);
  if (!s.rows.length) return <p className="mo-empty">{s.empty ?? 'Nothing to show.'}</p>;
  return (
    <>
      {(s.rows.length > 8 || s.filters) && (
        <div className="mo-tabletools">
          {s.rows.length > 8 && (
            <label className="mb-search">
              <Search size={14} aria-hidden="true" />
              <input type="search" value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search…" aria-label={`Search ${s.title}`} />
            </label>
          )}
          {s.filters && (
            <div className="mb-pills" role="group" aria-label="Filter rows">
              <button type="button" className="mb-pill" aria-pressed={tone === 'all'} onClick={() => setTone('all')}>
                All <span className="mb-pill-n">{s.rows.length}</span>
              </button>
              {s.filters.map((f) => (
                <button key={f.tone} type="button" className="mb-pill" aria-pressed={tone === f.tone} onClick={() => setTone(f.tone)}>
                  <span className={`mb-dot mb-t-${f.tone}`} aria-hidden="true" />
                  {f.label} <span className="mb-pill-n">{s.rows.filter((r) => r.tone === f.tone).length}</span>
                </button>
              ))}
            </div>
          )}
        </div>
      )}
      <div className="mo-tablewrap">
        <table className="wf-grid mo-table">
          <thead>
            <tr>
              {s.columns.map((c) => (
                <th key={c.label} className={c.num ? 'num' : undefined}>{c.label}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {rows.map((r, i) => (
              <tr key={i} className={r.tone ? `mo-row mb-t-${r.tone}` : undefined}>
                {r.cells.map((v, j) => (
                  <td key={j} className={s.columns[j]?.num ? 'num' : undefined}>
                    {j === 0 && r.href ? <Link href={r.href}>{v}</Link> : v}
                  </td>
                ))}
              </tr>
            ))}
            {!rows.length && (
              <tr>
                <td colSpan={s.columns.length} className="mo-empty">No rows match.</td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </>
  );
}
