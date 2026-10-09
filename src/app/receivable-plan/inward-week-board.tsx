'use client';

import { useMemo } from 'react';
import { InfoDot } from '@/components/info-dot';
import type { InwardPlanSheetRow } from '@/lib/forms/queries-modules/inward-plan-sheet';
import type { ArrivalRow } from '@/lib/forms/queries-modules/inward-receivable';

const fmt = new Intl.NumberFormat('en-IN', { maximumFractionDigits: 0 });
const DAY = 86_400_000;
const iso = (t: number) => new Date(t).toISOString().slice(0, 10);
const utc = (d: string) => Date.parse(`${d}T00:00:00Z`);
const short = (d: string) => new Date(utc(d)).toLocaleDateString('en-IN', { day: 'numeric', month: 'short', timeZone: 'UTC' });
const pctOf = (got: number, of: number) => (of > 0 ? Math.min(100, Math.round((got / of) * 100)) : 0);

function isoWeekNo(d: string): number {
  const t = new Date(utc(d));
  t.setUTCDate(t.getUTCDate() - ((t.getUTCDay() + 6) % 7) + 3); // Thursday of the week
  const firstThu = new Date(Date.UTC(t.getUTCFullYear(), 0, 4));
  return 1 + Math.round((t.getTime() - firstThu.getTime()) / (7 * DAY) - ((firstThu.getUTCDay() + 6) % 7 - 3) / 7);
}

/** "x of y" with a bar; never a share above 100% — received past the plan reads "over plan by". */
function Progress({ got, of }: { got: number; of: number }) {
  return (
    <>
      <div className="iw-bar"><i style={{ width: `${pctOf(got, of)}%` }} /></div>
      {of > 0 && got > of && <span className="iw-over">Over plan by {fmt.format(got - of)}</span>}
    </>
  );
}

type Board = 'weeks' | 'vendors';

/**
 * The month as a Mon–Sun week board (what the team expects each week against what landed,
 * day by day) and as vendor cards (each vendor's planned pieces against received).
 */
export function InwardWeekBoard({
  board,
  month,
  rows,
  arrivals,
  today,
}: {
  board: Board;
  /** YYYY-MM-01 */
  month: string;
  /** The monthly sheet's lines for this month. */
  rows: InwardPlanSheetRow[];
  /** Receivable-plan expectations (qty + receiving week) — matched to this month's POs. */
  arrivals: ArrivalRow[];
  /** YYYY-MM-DD, from the server. */
  today: string;
}) {
  const monthStart = utc(month);
  const monthEnd = Date.UTC(new Date(monthStart).getUTCFullYear(), new Date(monthStart).getUTCMonth() + 1, 0);
  const daysInMonth = Math.round((monthEnd - monthStart) / DAY) + 1;
  const elapsed = Math.max(0, Math.min(daysInMonth, Math.round((utc(today) - monthStart) / DAY) + 1));

  const weeks = useMemo(() => {
    const refs = new Set(rows.map((r) => (r.po_no ?? '').trim()).filter(Boolean));
    // Only week-level expectations on this month's POs; a whole-month expectation has no week.
    const expected = arrivals.filter(
      (a) => a.source === 'live' && a.expected_date && /W\d/.test(a.expected_week ?? '') && refs.has((a.po_ref_num ?? '').trim()),
    );
    const byDay = new Map<string, number>();
    for (const r of rows) for (const [d, q] of Object.entries(r.received_by_day)) byDay.set(d, (byDay.get(d) ?? 0) + q);
    const maxDay = Math.max(1, ...byDay.values());

    const first = monthStart - ((new Date(monthStart).getUTCDay() + 6) % 7) * DAY; // Monday on/before the 1st
    const out = [];
    for (let ws = first; ws <= monthEnd; ws += 7 * DAY) {
      const we = ws + 6 * DAY;
      const from = iso(ws);
      const to = iso(we);
      const lines = expected
        .filter((a) => (a.expected_date as string) >= from && (a.expected_date as string) <= to)
        .sort((a, b) => (b.expected_qty ?? 0) - (a.expected_qty ?? 0));
      const days = Array.from({ length: 7 }, (_, i) => {
        const d = iso(ws + i * DAY);
        const q = byDay.get(d) ?? 0;
        const inMonth = d.slice(0, 7) === month.slice(0, 7);
        return { d, q, inMonth, future: d > today, h: q ? Math.max(4, Math.round((q / maxDay) * 36)) : 3 };
      });
      out.push({
        key: from,
        name: `Week ${isoWeekNo(from)}`,
        range: `${short(from)} – ${short(to)}`,
        state: to < today ? 'done' : from <= today ? 'now' : 'next',
        expected: lines.reduce((s, a) => s + (a.expected_qty ?? 0), 0),
        received: days.reduce((s, x) => s + (x.inMonth ? x.q : 0), 0),
        lines,
        days,
      });
    }
    const weekRefs = new Set(expected.map((a) => (a.po_ref_num ?? '').trim()));
    const noWeek = rows.filter((r) => !weekRefs.has((r.po_no ?? '').trim())).length;
    return { list: out, noWeek };
  }, [rows, arrivals, month, monthStart, monthEnd, today]);

  const vendors = useMemo(() => {
    const map = new Map<string, { name: string; lines: number; planned: number; received: number; last: string | null }>();
    for (const r of rows) {
      const name = r.vendor_name?.trim() || '—';
      const v = map.get(name) ?? { name, lines: 0, planned: 0, received: 0, last: null };
      v.lines += 1;
      v.planned += r.inward_qty ?? 0;
      v.received += r.received_in_month;
      for (const d of Object.keys(r.received_by_day)) if (!v.last || d > v.last) v.last = d;
      map.set(name, v);
    }
    const pace = elapsed / daysInMonth;
    return [...map.values()]
      .map((v) => {
        const share = v.planned > 0 ? v.received / v.planned : 0;
        const flag =
          v.planned > 0 && v.received >= v.planned ? { text: 'Fully received', tone: 'ok' }
          : elapsed === 0 ? { text: 'Not due yet', tone: 'grey' }
          : v.received === 0 ? { text: 'Nothing received', tone: 'warn' }
          : share < pace / 2 ? { text: 'Behind', tone: 'warn' }
          : { text: 'On track', tone: 'ok' };
        return { ...v, pct: pctOf(v.received, v.planned), flag };
      })
      .sort((a, b) => (b.planned - b.received) - (a.planned - a.received));
  }, [rows, elapsed, daysInMonth]);

  if (!rows.length) return null;

  if (board === 'vendors') {
    return (
      <section aria-label="Vendors this month">
        <div className="iw-head">
          <h3>Vendors this month</h3>
          <span className="wf-subtle">
            Sorted by pieces still to come{' '}
            <InfoDot text={'Received = goods-receipt pieces on the vendor\'s plan POs dated inside the month.\n\nBehind = less than half of what an even pace through the month would have brought by today. Nothing received = no receipt yet this month.'} />
          </span>
        </div>
        <div className="iw-vendors">
          {vendors.map((v) => (
            <article key={v.name} className="iw-vendor">
              <div className="iw-ring" style={{ background: `conic-gradient(var(--ink-1, #161513) ${v.pct * 3.6}deg, #eceae4 0)` }}>
                <span>{v.planned > 0 && v.received > v.planned ? 'Over' : `${v.pct}%`}</span>
              </div>
              <div className="iw-vendor-body">
                <div className="iw-row"><b>{v.name}</b><span className={`iw-pill iw-${v.flag.tone}`}>{v.flag.text}</span></div>
                <div className="wf-subtle">{v.lines} line{v.lines === 1 ? '' : 's'} · {fmt.format(v.received)} of {fmt.format(v.planned)} pcs</div>
                <div className="wf-subtle">Last receipt {v.last ? short(v.last) : '—'}</div>
              </div>
            </article>
          ))}
        </div>
      </section>
    );
  }

  return (
    <section aria-label="Week by week">
      <div className="iw-head">
        <h3>Week by week · Mon–Sun</h3>
        <span className="wf-subtle">
          {weeks.noWeek > 0 && <>{weeks.noWeek} of {rows.length} plan lines have no receiving week yet · </>}
          <InfoDot text={'Expected = the quantity the team entered for that receiving week on Input inward plan, for this month\'s POs. A line planned for the whole month has no week, so it is not in a column.\n\nReceived = goods-receipt pieces on this month\'s plan POs, by receipt day. Days outside the month are greyed and not counted.'} />
        </span>
      </div>
      <div className="iw-weeks-scroll">
        <div className="iw-weeks" style={{ gridTemplateColumns: `repeat(${weeks.list.length}, minmax(220px, 1fr))` }}>
          {weeks.list.map((w) => (
            <article key={w.key} className={`iw-week${w.state === 'now' ? ' is-now' : ''}`}>
              <div className="iw-week-top">
                <div className="iw-row">
                  <b>{w.name}</b>
                  <span className={`iw-pill ${w.state === 'now' ? 'iw-info' : 'iw-grey'}`}>{w.state === 'done' ? 'Done' : w.state === 'now' ? 'This week' : 'Upcoming'}</span>
                </div>
                <div className="wf-subtle">{w.range}</div>
                <div className="iw-row iw-figs">
                  <span>Expected <b>{fmt.format(w.expected)}</b></span>
                  <span>Received <b>{fmt.format(w.received)}</b></span>
                </div>
                <Progress got={w.received} of={w.expected} />
                <div className="iw-days" aria-label="Received by day">
                  {w.days.map((d) => (
                    <div
                      key={d.d}
                      title={`${short(d.d)}: ${d.future ? 'upcoming' : `${fmt.format(d.q)} pcs`}`}
                      className={`iw-day${!d.inMonth ? ' is-out' : d.future ? ' is-future' : d.q ? ' has' : ''}`}
                      style={{ height: d.future || !d.inMonth ? 3 : d.h }}
                    />
                  ))}
                </div>
                <div className="iw-daynames" aria-hidden="true"><span>M</span><span>T</span><span>W</span><span>T</span><span>F</span><span>S</span><span>S</span></div>
              </div>
              <div className="iw-week-lines">
                {w.lines.slice(0, 4).map((a) => (
                  <div key={a.row_key} className="iw-line">
                    <div className="iw-row"><b className="mono">{a.product_variant || a.product_code}</b><span className="wf-subtle">{a.vendor_name ?? '—'}</span></div>
                    <div className="iw-row wf-subtle"><span>{fmt.format(a.received_qty)} / {fmt.format(a.expected_qty ?? 0)} pcs</span><span>{a.po_ref_num?.split('/')[1] ?? ''}</span></div>
                    <Progress got={a.received_qty} of={a.expected_qty ?? 0} />
                  </div>
                ))}
                {w.lines.length > 4 && <div className="wf-subtle iw-more">+ {w.lines.length - 4} more line{w.lines.length - 4 === 1 ? '' : 's'}</div>}
                {!w.lines.length && <div className="wf-subtle iw-more">No receiving week set for this week</div>}
              </div>
            </article>
          ))}
        </div>
      </div>
    </section>
  );
}
