'use client';

import { useEffect, useMemo, useState } from 'react';
import { STATUS_LABEL } from '@/lib/forms/approval';
import type { SdStatus } from '@/lib/forms/types';
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
  // The week opened below the board (its key = the Monday), or none.
  const [open, setOpen] = useState<string | null>(null);
  useEffect(() => {
    if (open) document.getElementById('iw-week-detail')?.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
  }, [open]);
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

  const openWeek = weeks.list.find((w) => w.key === open) ?? null;

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
            <article key={w.key} className={`iw-week${w.state === 'now' ? ' is-now' : ''}${open === w.key ? ' is-open' : ''}`}>
              <button
                type="button"
                className="iw-week-top"
                aria-expanded={open === w.key}
                aria-controls="iw-week-detail"
                onClick={() => setOpen(open === w.key ? null : w.key)}
              >
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
              </button>
              <div className="iw-week-lines">
                {w.lines.slice(0, 4).map((a) => (
                  <button key={a.row_key} type="button" className="iw-line" onClick={() => setOpen(w.key)}>
                    <div className="iw-row"><b className="mono">{a.product_variant || a.product_code}</b><span className="wf-subtle">{a.vendor_name ?? '—'}</span></div>
                    <div className="iw-row wf-subtle"><span>{fmt.format(a.received_qty)} / {fmt.format(a.expected_qty ?? 0)} pcs</span><span>{a.po_ref_num?.split('/')[1] ?? ''}</span></div>
                    <Progress got={a.received_qty} of={a.expected_qty ?? 0} />
                  </button>
                ))}
                {w.lines.length > 4 && (
                  <button type="button" className="iw-more iw-more-btn" onClick={() => setOpen(w.key)}>
                    + {w.lines.length - 4} more line{w.lines.length - 4 === 1 ? '' : 's'}
                  </button>
                )}
                {!w.lines.length && <div className="wf-subtle iw-more">No receiving week set for this week</div>}
              </div>
            </article>
          ))}
        </div>
      </div>
      {openWeek && <WeekDetail week={openWeek} onClose={() => setOpen(null)} />}
    </section>
  );
}

type Week = {
  key: string;
  name: string;
  range: string;
  expected: number;
  received: number;
  lines: ArrivalRow[];
  days: { d: string; q: number; inMonth: boolean; future: boolean }[];
};

/** Everything in one week: receipts by day, and every line the team expects that week. */
function WeekDetail({ week, onClose }: { week: Week; onClose: () => void }) {
  const status = (s: string | null) => (s ? STATUS_LABEL[s as SdStatus] ?? s : '—');
  return (
    <section id="iw-week-detail" className="iw-detail" aria-label={`${week.name} in detail`}>
      <div className="iw-detail-head">
        <div>
          <h3>{week.name} · {week.range}</h3>
          <span className="wf-subtle">
            Expected {fmt.format(week.expected)} pcs · received {fmt.format(week.received)} pcs on this month&rsquo;s POs
          </span>
        </div>
        <button type="button" className="wf-btn wf-btn-ghost wf-btn-sm" onClick={onClose}>Close</button>
      </div>
      <div className="iw-detail-days">
        {week.days.map((d) => (
          <div key={d.d} className={`iw-detail-day${!d.inMonth ? ' is-out' : ''}`}>
            <span>{new Date(utc(d.d)).toLocaleDateString('en-IN', { weekday: 'short', day: 'numeric', timeZone: 'UTC' })}</span>
            <b>{!d.inMonth ? '—' : d.future ? 'upcoming' : fmt.format(d.q)}</b>
          </div>
        ))}
      </div>
      {week.lines.length ? (
        <div className="table-scroll">
          <table className="wide-table">
            <thead>
              <tr>
                <th>Product / colour</th>
                <th>PO ref</th>
                <th>Vendor</th>
                <th>Expected on</th>
                <th className="num">Expected</th>
                <th className="num">Received so far</th>
                <th>Plan status</th>
              </tr>
            </thead>
            <tbody>
              {week.lines.map((a) => (
                <tr key={a.row_key}>
                  <td className="mono">{a.product_variant || a.product_code || '—'}</td>
                  <td className="mono">{a.po_ref_num ?? a.po_number ?? '—'}</td>
                  <td>{a.vendor_name ?? '—'}</td>
                  <td>{a.expected_date ? short(a.expected_date) : '—'}</td>
                  <td className="num">{fmt.format(a.expected_qty ?? 0)}</td>
                  <td className="num">
                    {fmt.format(a.received_qty)}
                    {a.expected_qty != null && a.received_qty > a.expected_qty && <span className="iw-over">over by {fmt.format(a.received_qty - a.expected_qty)}</span>}
                  </td>
                  <td>{status(a.status)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : (
        <p className="wf-subtle" style={{ margin: 0 }}>No line on this month&rsquo;s POs has its receiving week set to this week.</p>
      )}
    </section>
  );
}
