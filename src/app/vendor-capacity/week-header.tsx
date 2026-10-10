import Link from 'next/link';

/** One week on the Vendor Capacity board, as the header needs it. */
export type HeaderWeek = {
  /** The week's Monday (IST), ISO date. */
  week: string;
  /** Board column key: live = Submitted, pending = Partial Submitted, back = Not Submitted. */
  status: string;
  submitted: number;
  total: number;
};

const STATUS: Record<string, [string, string]> = {
  live: ['ok', 'Submitted'],
  pending: ['warn', 'Partial Submitted'],
  back: ['crit', 'Not Submitted'],
};

const shift = (w: string, days: number) => new Date(Date.parse(`${w}T00:00:00Z`) + days * 86_400_000).toISOString().slice(0, 10);
const day = (iso: string, year = false) =>
  new Date(`${iso}T00:00:00Z`).toLocaleDateString('en-IN', { day: 'numeric', month: 'short', ...(year ? { year: 'numeric' } : {}), timeZone: 'UTC' });
const weekLabel = (w: string) => `${day(w)} – ${day(shift(w, 6), true)}`;
const weekNo = (w: string) => {
  const thu = Date.parse(`${shift(w, 3)}T00:00:00Z`);
  return Math.floor((thu - Date.UTC(new Date(thu).getUTCFullYear(), 0, 1)) / 86_400_000 / 7) + 1;
};

function StatusBadge({ w }: { w?: HeaderWeek }) {
  const [tone, text] = STATUS[w?.status ?? 'back'] ?? STATUS.back;
  return <span className={`vc2-badge ${tone}`}><i />{text}</span>;
}

/**
 * The week page header (Option A of the header demo): an "All weeks" link, the week as the
 * heading with its submission status, and a week picker (‹ Week N ▾ ›) whose list shows every
 * board week with its status. Statuses come from the board itself, so the two never disagree.
 * Server-rendered; the dropdown is a <details>, so it needs no client code.
 */
export function WeekHeader({ weeks, shown, current }: { weeks: HeaderWeek[]; shown: string; current: string }) {
  const sorted = [...weeks].sort((a, b) => a.week.localeCompare(b.week));
  const at = sorted.findIndex((w) => w.week === shown);
  const me = at >= 0 ? sorted[at] : undefined;
  const prev = at > 0 ? sorted[at - 1] : undefined;
  const next = at >= 0 && at < sorted.length - 1 ? sorted[at + 1] : undefined;
  const href = (w: string) => (w >= current ? '/vendor-capacity?view=vendors' : `/vendor-capacity?view=vendors&week=${w}`);
  const isCurrent = shown >= current;

  return (
    <div className="vc2-head">
      <Link className="vc2-crumb" href="/vendor-capacity">
        <svg width="14" height="14" viewBox="0 0 16 16" aria-hidden="true"><path d="M10 3L5 8l5 5" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" /></svg>
        All weeks
      </Link>
      <div className="vc2-head-row">
        <div className="vc2-head-main">
          <div className="vc2-head-title">
            <h2>{weekLabel(shown)}</h2>
            <StatusBadge w={me} />
            {isCurrent ? <span className="vc2-badge ok"><i />This week · entry open</span> : <span className="vc2-badge">View only</span>}
          </div>
          <p className="vc2-head-meta">
            Week {weekNo(shown)} · Monday to Sunday
            {me ? ` · ${me.submitted} of ${me.total} vendors submitted` : ''}
          </p>
        </div>
        <div className="vc2-head-actions">
          <div className="vc2-picker">
            {prev ? (
              <Link className="vc2-picker-arw" href={href(prev.week)} aria-label="Previous week" title={`Previous week: ${weekLabel(prev.week)}`}>‹</Link>
            ) : (
              <span className="vc2-picker-arw is-off" aria-hidden="true">‹</span>
            )}
            <details className="vc2-picker-menu">
              <summary>
                Week {weekNo(shown)}
                <svg width="12" height="12" viewBox="0 0 16 16" aria-hidden="true"><path d="M4 6l4 4 4-4" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" /></svg>
              </summary>
              <div className="vc2-picker-list" role="menu">
                {[...sorted].reverse().map((w) => (
                  <Link key={w.week} role="menuitem" href={href(w.week)} className={w.week === shown ? 'is-on' : undefined}>
                    <b>{weekLabel(w.week)}</b>
                    <StatusBadge w={w} />
                    <small>Week {weekNo(w.week)}{w.week >= current ? ' · this week' : ''}</small>
                    <small>{w.submitted} / {w.total}</small>
                  </Link>
                ))}
                <Link role="menuitem" href="/vendor-capacity" className="vc2-picker-board">Open the week board</Link>
              </div>
            </details>
            {next ? (
              <Link className="vc2-picker-arw" href={href(next.week)} aria-label="Next week" title={`Next week: ${weekLabel(next.week)}`}>›</Link>
            ) : (
              <span className="vc2-picker-arw is-off" aria-hidden="true">›</span>
            )}
          </div>
          {!isCurrent && <Link className="vc2-btn vc2-btn-primary" href="/vendor-capacity?view=vendors">Go to this week</Link>}
        </div>
      </div>
    </div>
  );
}
