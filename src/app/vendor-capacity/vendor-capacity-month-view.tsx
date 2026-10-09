'use client';

import { useState, useTransition } from 'react';
import Link from 'next/link';
import { FileDown, Send, RefreshCw } from 'lucide-react';
import { generateVendorCapacityReportAction, getVendorCapacityReportUrl } from '@/lib/forms/actions';
import { reloadWithToast, toastError } from '@/lib/toast';
import { OVER_UTILISED, isOverUtilised, utilisationLabel } from '@/lib/utilisation';
import type { VendorCapacityMonth, VendorCapacityReportStatus } from '@/lib/vendor-capacity-month-types';

const n0 = new Intl.NumberFormat('en-IN', { maximumFractionDigits: 0 });
const num = (v: number | null | undefined) => (v == null ? '—' : n0.format(Math.round(v)));
const when = (iso: string | null) =>
  iso ? new Date(iso).toLocaleString('en-IN', { day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit', timeZone: 'Asia/Kolkata' }) : '—';
const dayOnly = (iso: string | null) =>
  iso ? new Date(iso).toLocaleDateString('en-IN', { day: 'numeric', month: 'short', timeZone: 'Asia/Kolkata' }) : '—';
const MON = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const short = (m: string) => `${MON[Number(m.slice(5, 7)) - 1]} ${m.slice(0, 4)}`;
const href = (m: string) => `/vendor-capacity?view=month&month=${m}`;

function Util({ v }: { v: number | null }) {
  return <span className={isOverUtilised(v) ? 'vc-util-over' : undefined}>{utilisationLabel(v)}</span>;
}

/**
 * Vendor Capacity → Monthly analysis (2026-10-09): the weekly input rolled up for a month —
 * who kept their capacity current, how declared capacity moved, how much of it was on order —
 * and the month's mandatory report to management (PDF, sent on the 1st by the month-close job).
 */
export function VendorCapacityMonthView({
  data,
  report,
  months,
  isAdmin,
}: {
  data: VendorCapacityMonth;
  report: VendorCapacityReportStatus;
  /** Months that can be opened, oldest first. */
  months: string[];
  isAdmin: boolean;
}) {
  const [pending, start] = useTransition();
  const [filter, setFilter] = useState<'all' | 'missed' | 'over'>('all');
  const at = months.indexOf(data.month);
  const prev = at > 0 ? months[at - 1] : null;
  const next = at >= 0 && at < months.length - 1 ? months[at + 1] : null;
  const t = data.totals;

  const vendors = data.vendors.filter((v) =>
    filter === 'missed' ? v.weeksUpdated < v.weeksExpected : filter === 'over' ? v.weeksOver > 0 : true,
  );
  const missed = data.vendors.filter((v) => v.weeksUpdated < v.weeksExpected).length;

  function generate(post: boolean) {
    const fd = new FormData();
    fd.set('month', data.month);
    if (post) fd.set('post', '1');
    start(async () => {
      const r = await generateVendorCapacityReportAction(fd);
      if (r.ok) reloadWithToast(r.message ?? 'Done.');
      else toastError(r.error);
    });
  }
  function download() {
    if (!report) return;
    start(async () => {
      const r = await getVendorCapacityReportUrl(report.storagePath);
      if ('url' in r) window.open(r.url, '_blank', 'noopener,noreferrer');
      else toastError(r.error);
    });
  }

  const reportState = report?.slackPostedAt
    ? { tone: 'ok', text: `Sent to management ${when(report.slackPostedAt)}` }
    : report
      ? { tone: 'warn', text: `Generated ${when(report.generatedAt)} — not sent yet${report.slackError ? ` (${report.slackError})` : ''}` }
      : data.closed
        ? { tone: 'crit', text: 'Not sent — the report for this month is overdue' }
        : { tone: '', text: `Goes to management automatically on 1 ${MON[(Number(data.month.slice(5, 7))) % 12]} at 9:00 am` };

  return (
    <>
      <div className="vc2-head">
        <Link className="vc2-crumb" href="/vendor-capacity">
          <svg width="14" height="14" viewBox="0 0 16 16" aria-hidden="true"><path d="M10 3L5 8l5 5" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" /></svg>
          All weeks
        </Link>
        <div className="vc2-head-row">
          <div className="vc2-head-main">
            <div className="vc2-head-title">
              <h2>{data.label} · Monthly analysis</h2>
              {data.closed ? <span className="vc2-badge">Month closed</span> : <span className="vc2-badge ok"><i />Month running</span>}
            </div>
            <p className="vc2-head-meta">
              Weekly input, monthly analysis · {data.weeks.length} week{data.weeks.length === 1 ? '' : 's'} (Monday to Sunday) · {t.active} active vendors
            </p>
          </div>
          <div className="vc2-head-actions">
            <div className="vc2-picker">
              {prev ? <Link className="vc2-picker-arw" href={href(prev)} aria-label="Previous month" title={short(prev)}>‹</Link> : <span className="vc2-picker-arw is-off" aria-hidden="true">‹</span>}
              <details className="vc2-picker-menu">
                <summary>
                  {short(data.month)}
                  <svg width="12" height="12" viewBox="0 0 16 16" aria-hidden="true"><path d="M4 6l4 4 4-4" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" /></svg>
                </summary>
                <div className="vc2-picker-list" role="menu">
                  {[...months].reverse().map((m) => (
                    <Link key={m} role="menuitem" href={href(m)} className={m === data.month ? 'is-on' : undefined}>
                      <b>{short(m)}</b>
                    </Link>
                  ))}
                </div>
              </details>
              {next ? <Link className="vc2-picker-arw" href={href(next)} aria-label="Next month" title={short(next)}>›</Link> : <span className="vc2-picker-arw is-off" aria-hidden="true">›</span>}
            </div>
          </div>
        </div>
      </div>

      <section className="vcm-report" aria-label="Report to management">
        <div>
          <span className="vcm-report-title">Monthly report to management</span>
          <span className={`vc2-badge ${reportState.tone}`}>
            {reportState.tone && <i />}
            {reportState.text}
          </span>
        </div>
        <div className="vcm-report-actions">
          {report && (
            <button type="button" className="wf-btn wf-btn-ghost wf-btn-sm" onClick={download} disabled={pending}>
              <FileDown size={14} aria-hidden="true" /> Download PDF
            </button>
          )}
          {isAdmin && (
            <>
              <button type="button" className="wf-btn wf-btn-ghost wf-btn-sm" onClick={() => generate(false)} disabled={pending}>
                <RefreshCw size={14} aria-hidden="true" /> {report ? 'Rebuild PDF' : 'Build PDF'}
              </button>
              <button type="button" className="wf-btn wf-btn-primary wf-btn-sm" onClick={() => generate(true)} disabled={pending}>
                <Send size={14} aria-hidden="true" /> {report?.slackPostedAt ? 'Send again' : 'Build & send to management'}
              </button>
            </>
          )}
        </div>
      </section>

      <div className="vcm-tiles">
        <div className="vcm-tile">
          <span>Weekly input</span>
          <b>{t.compliancePct == null ? '—' : `${Math.round(t.compliancePct)}%`}</b>
          <small>{t.vendorWeeksUpdated} of {t.vendorWeeksExpected} vendor-weeks updated</small>
        </div>
        <div className={`vcm-tile${t.neverUpdated ? ' is-warn' : ''}`}>
          <span>Never updated this month</span>
          <b>{t.neverUpdated}</b>
          <small>of {t.active} active vendors</small>
        </div>
        <div className="vcm-tile">
          <span>Capacity declared</span>
          <b>{num(t.capEnd)}</b>
          <small>pcs / month · first week {num(t.capStart)}</small>
        </div>
        <div className={`vcm-tile${isOverUtilised(t.utilEnd) ? ' is-crit' : ''}`}>
          <span>Capacity used (last week)</span>
          <b>{t.utilEnd != null && isOverUtilised(t.utilEnd) ? OVER_UTILISED : utilisationLabel(t.utilEnd)}</b>
          <small>{num(t.onOrderEnd)} on order of {num(t.poCapEnd)} PO capacity</small>
        </div>
        <div className={`vcm-tile${t.overAnyWeek ? ' is-crit' : ''}`}>
          <span>Over capacity</span>
          <b>{t.overAnyWeek}</b>
          <small>vendors, in at least one week</small>
        </div>
      </div>

      <h3 className="vcm-h">Week by week</h3>
      <div className="table-panel wf-grid-panel">
        <div className="table-scroll">
          <table className="wf-grid">
            <thead>
              <tr>
                <th>Week (Mon–Sun)</th>
                <th className="num">Vendors updated</th>
                <th className="num">Capacity / month</th>
                <th className="num">PO capacity</th>
                <th className="num">On order</th>
                <th>Capacity used</th>
                <th className="num">Over capacity</th>
              </tr>
            </thead>
            <tbody>
              {data.weeks.map((w) => (
                <tr key={w.week}>
                  <td>
                    <Link href={w.running ? '/vendor-capacity?view=vendors' : `/vendor-capacity?view=vendors&week=${w.week}`}>{w.label}</Link>
                    {w.running && <small className="wf-subtle"> · running</small>}
                  </td>
                  <td className="num">{w.updated} / {w.active}</td>
                  <td className="num">{num(w.capacityPerMonth)}</td>
                  <td className="num">{num(w.poCapacity)}</td>
                  <td className="num">{w.onOrder == null ? <span className="wf-subtle" title="No end-of-week copy was kept for this week">not kept</span> : num(w.onOrder)}</td>
                  <td><Util v={w.util} /></td>
                  <td className="num">{w.overVendors ?? '—'}</td>
                </tr>
              ))}
              {!data.weeks.length && (
                <tr><td colSpan={7} className="wf-empty-cell">This month has not started yet.</td></tr>
              )}
            </tbody>
          </table>
        </div>
      </div>

      <div className="vcm-vendor-head">
        <h3 className="vcm-h">By vendor</h3>
        <div className="segment wf-segment">
          <button type="button" className={filter === 'all' ? 'active' : ''} onClick={() => setFilter('all')}>All ({data.vendors.length})</button>
          <button type="button" className={filter === 'missed' ? 'active' : ''} onClick={() => setFilter('missed')}>Missed a week ({missed})</button>
          <button type="button" className={filter === 'over' ? 'active' : ''} onClick={() => setFilter('over')}>Over capacity ({t.overAnyWeek})</button>
        </div>
      </div>
      <div className="table-panel wf-grid-panel">
        <div className="table-scroll">
          <table className="wf-grid">
            <thead>
              <tr>
                <th>Vendor</th>
                <th className="num">Weeks updated</th>
                <th className="num">Capacity / month (start → end)</th>
                <th className="num">Signed</th>
                <th className="num">On order (last week)</th>
                <th>Average used</th>
                <th>Peak used</th>
                <th className="num">Weeks over</th>
                <th>Last update</th>
              </tr>
            </thead>
            <tbody>
              {vendors.map((v) => (
                <tr key={v.code}>
                  <td>
                    {v.name}
                    <small className="vr-row-sub">{[v.code, v.type].filter(Boolean).join(' · ')}</small>
                  </td>
                  <td className={`num${v.weeksUpdated < v.weeksExpected ? ' vcm-miss' : ''}`}>{v.weeksUpdated} / {v.weeksExpected}</td>
                  <td className="num">{num(v.capStart)} → {num(v.capEnd)}</td>
                  <td className="num">{num(v.signed)}</td>
                  <td className="num">{num(v.onOrderEnd)}</td>
                  <td><Util v={v.avgUtil} /></td>
                  <td><Util v={v.peakUtil} /></td>
                  <td className="num">{v.weeksOver || '—'}</td>
                  <td className="wf-subtle">{dayOnly(v.lastUpdate)}</td>
                </tr>
              ))}
              {!vendors.length && (
                <tr><td colSpan={9} className="wf-empty-cell">No vendor matches this filter.</td></tr>
              )}
            </tbody>
          </table>
        </div>
      </div>

      <ul className="vr-basis vcm-notes">
        {data.notes.map((n) => (
          <li key={n}>{n}</li>
        ))}
      </ul>
    </>
  );
}
