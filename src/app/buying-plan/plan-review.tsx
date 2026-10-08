'use client';

import { useState, useTransition, type ReactNode } from 'react';
import { Check, ChevronDown, ChevronUp, RotateCcw, X } from 'lucide-react';
import { decidePlanLines } from '@/lib/forms/actions';
import { reloadWithToast, toastError } from '@/lib/toast';

type Decision = 'approve' | 'rework' | 'reject';

/** One line of the plan under review, already worked out by the page. */
export type ReviewLine = {
  lineId: number;
  code: string;
  sub: string;
  routes: { label: string; qty: number; kind: 'job' | 'efob' | 'fob' | 'buy' }[];
  qty: number;
  qtyText: string;
  value: number | null;
  /** Value per route, for the summary (same order as routeTotals labels). */
  routeValue: Record<string, number>;
  group: string;
  lineStatus: string | null;
  note: string | null;
  flags: { npd?: boolean; nocost?: boolean; nostate?: boolean };
};

const QUICK: Record<'rework' | 'reject', string[]> = {
  rework: ['Quantity too high', 'Quantity too low', 'Wrong PO type', 'Check against demand'],
  reject: ['Not needed this month', 'No approved cost', 'Product being discontinued', 'Duplicate line'],
};

const fmt = new Intl.NumberFormat('en-IN', { maximumFractionDigits: 0 });
function inr(v: number) {
  const abs = Math.abs(v);
  if (abs >= 1e7) return `₹${(v / 1e7).toFixed(2)} Cr`;
  if (abs >= 1e5) return `₹${(v / 1e5).toFixed(2)} L`;
  return `₹${fmt.format(Math.round(v))}`;
}
const saved = (s: string | null): Decision | null =>
  s === 'approved' ? 'approve' : s === 'rework' ? 'rework' : s === 'rejected' ? 'reject' : null;

/**
 * The approver's review of a buying plan (approved demo, 2026-10-08): a header with the stage,
 * dates and line progress; filter chips; one Approve / Rework / Reject control per line with an
 * inline reason; bulk decisions on ticked lines. Decisions are held on screen and saved together
 * with Confirm decisions — one save, one notice to the team. The whole-plan decision (Approve,
 * Edit & approve, Rework, Reject with one comment) stays available under "Decide the whole plan".
 */
export function PlanReview({
  planId,
  entityLabel,
  monthLabel,
  trackLabel,
  stageLabel,
  facts,
  lines,
  routeLabels,
  groupLabel,
  noun,
  wholePlan,
}: {
  planId: number;
  entityLabel: string;
  monthLabel: string;
  trackLabel: string;
  stageLabel: string;
  facts: { text: string; tone?: 'red' }[];
  lines: ReviewLine[];
  routeLabels: string[];
  groupLabel: string;
  noun: string;
  wholePlan: ReactNode;
}) {
  const [staged, setStaged] = useState<Record<number, Decision | null>>({});
  const [notes, setNotes] = useState<Record<number, string>>({});
  const [openReason, setOpenReason] = useState<number | null>(null);
  const [filter, setFilter] = useState<'all' | 'pending' | Decision | 'flag'>('pending');
  const [q, setQ] = useState('');
  const [sel, setSel] = useState<Set<number>>(new Set());
  const [showWhole, setShowWhole] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [pending, start] = useTransition();

  const current = (l: ReviewLine): Decision | null => (l.lineId in staged ? staged[l.lineId] : saved(l.lineStatus));
  const noteOf = (l: ReviewLine) => notes[l.lineId] ?? l.note ?? '';
  const flagged = (l: ReviewLine) => Boolean(l.flags.npd || l.flags.nocost || l.flags.nostate);
  const changes = lines.filter((l) => l.lineId in staged && staged[l.lineId] !== saved(l.lineStatus) && staged[l.lineId] != null);
  const count = (d: Decision) => lines.filter((l) => current(l) === d).length;
  const a = count('approve');
  const w = count('rework');
  const r = count('reject');
  const p = lines.length - a - w - r;
  const total = lines.reduce((s, l) => s + (l.value ?? 0), 0);

  // A line stays in view while its reason box is open, even if the filter would hide it.
  const shown = lines.filter((l) => {
    if (l.lineId === openReason) return true;
    if (q && !l.code.toLowerCase().includes(q.toLowerCase())) return false;
    if (filter === 'all') return true;
    if (filter === 'pending') return !current(l);
    if (filter === 'flag') return flagged(l);
    return current(l) === filter;
  });

  function decide(l: ReviewLine, d: Decision) {
    setError(null);
    const was = current(l);
    if (was === d && openReason !== l.lineId) {
      setStaged((s) => ({ ...s, [l.lineId]: null }));
      return;
    }
    setStaged((s) => ({ ...s, [l.lineId]: d }));
    setOpenReason(d !== 'approve' && !noteOf(l).trim() ? l.lineId : null);
  }
  function bulk(d: Decision) {
    const ids = [...sel];
    setStaged((s) => ({ ...s, ...Object.fromEntries(ids.map((id) => [id, d])) }));
    if (d !== 'approve') {
      const first = lines.find((l) => ids.includes(l.lineId) && !noteOf(l).trim());
      if (first) setOpenReason(first.lineId);
    }
    setSel(new Set());
  }
  function approveRemaining() {
    setStaged((s) => ({ ...s, ...Object.fromEntries(lines.filter((l) => !current(l)).map((l) => [l.lineId, 'approve' as Decision])) }));
  }
  function confirm() {
    setError(null);
    const needReason = changes.filter((l) => staged[l.lineId] !== 'approve' && !noteOf(l).trim());
    if (needReason.length) {
      setOpenReason(needReason[0].lineId);
      setError(`${needReason.length} line${needReason.length === 1 ? ' needs' : 's need'} a reason before saving.`);
      return;
    }
    const fd = new FormData();
    fd.set('plan_id', String(planId));
    fd.set('entity_label', entityLabel);
    fd.set('decisions', JSON.stringify(changes.map((l) => ({ lineId: l.lineId, decision: staged[l.lineId], note: staged[l.lineId] === 'approve' ? '' : noteOf(l).trim() }))));
    start(async () => {
      const res = await decidePlanLines(fd);
      if (res.ok) reloadWithToast(res.message ?? 'Saved.');
      else setError(toastError(res.error));
    });
  }

  // Outcome if confirmed now.
  const keptValue = lines.filter((l) => current(l) !== 'reject').reduce((s, l) => s + (l.value ?? 0), 0);
  const outcome =
    !a && !w && !r
      ? { tone: 'idle', title: 'Nothing decided yet', body: 'Pick a decision on each line, or approve the remaining lines in one go.' }
      : w
        ? { tone: 'warn', title: 'Plan goes back to the team', body: `${w} line${w === 1 ? '' : 's'} sent for rework. ${a} approved line${a === 1 ? '' : 's'} stay approved; the team fixes the rest and resubmits.` }
        : p
          ? { tone: 'idle', title: 'Plan stays with you', body: `${a} approved, ${r} rejected · ${p} line${p === 1 ? '' : 's'} still to decide.` }
          : a
            ? { tone: 'ok', title: 'Plan is approved', body: `${a} line${a === 1 ? '' : 's'} · ${inr(keptValue)}${r ? ` · ${r} rejected line${r === 1 ? '' : 's'} left out` : ''}. POs can be issued against it.` }
            : { tone: 'bad', title: 'Plan is rejected', body: 'Every line was rejected.' };

  const kept = lines.filter((l) => current(l) !== 'reject');
  // routes[] is in the same order as routeLabels.
  const routeTotals = routeLabels.map((label, i) => ({
    label,
    value: kept.reduce((s, l) => s + (l.routeValue[label] ?? 0), 0),
    qty: kept.reduce((s, l) => s + (l.routes[i]?.qty ?? 0), 0),
  }));
  const routeSum = routeTotals.reduce((s, x) => s + x.value, 0);
  const groups = [...new Set(kept.map((l) => l.group))]
    .map((g) => ({ g, value: kept.filter((l) => l.group === g).reduce((s, l) => s + (l.value ?? 0), 0) }))
    .sort((x, y) => y.value - x.value);
  const flagRows: [string, ReviewLine[]][] = [
    ['NPD lines', lines.filter((l) => l.flags.npd)],
    ['No approved cost', lines.filter((l) => l.flags.nocost)],
    ['No product state / weave', lines.filter((l) => l.flags.nostate)],
  ];

  const allShownSelected = shown.length > 0 && shown.every((l) => sel.has(l.lineId));
  const chip = (key: typeof filter, label: string, n: number) => (
    <button type="button" className="rv-chip" aria-pressed={filter === key} onClick={() => setFilter(key)}>
      {label} <span className="n">{n}</span>
    </button>
  );

  return (
    <section className="rv" aria-label="Plan review">
      <div className="bp-card rv-head">
        <div>
          <div className="rv-kicker">Buying Plan · {trackLabel} · {stageLabel}</div>
          <h2>
            {monthLabel}
            <span className={`bp-badge ${p ? 'yellow' : w ? 'red' : 'green'}`}>{p ? 'Awaiting your decision' : 'Every line decided'}</span>
          </h2>
          <div className="rv-meta">
            {facts.map((f) => (
              <span key={f.text} className={f.tone === 'red' ? 'late' : ''}>{f.text}</span>
            ))}
            <span>
              <b>{lines.length}</b> {noun}s · <b>{inr(total)}</b>
            </span>
          </div>
        </div>
        <div className="rv-actions">
          <button type="button" className="wf-btn wf-btn-ghost" onClick={() => setShowWhole((o) => !o)} aria-expanded={showWhole}>
            Decide the whole plan {showWhole ? <ChevronUp size={14} /> : <ChevronDown size={14} />}
          </button>
          <button type="button" className="wf-btn wf-btn-primary" onClick={approveRemaining} disabled={!p}>
            <Check size={15} /> Approve remaining {p}
          </button>
        </div>
        <div className="rv-progress">
          <div className="rv-bar" aria-hidden="true">
            <i className="a" style={{ width: `${(a / Math.max(1, lines.length)) * 100}%` }} />
            <i className="w" style={{ width: `${(w / Math.max(1, lines.length)) * 100}%` }} />
            <i className="r" style={{ width: `${(r / Math.max(1, lines.length)) * 100}%` }} />
          </div>
          <div className="rv-legend">
            <span className="a">Approved <b>{a}</b></span>
            <span className="w">Rework <b>{w}</b></span>
            <span className="r">Rejected <b>{r}</b></span>
            <span className="p">To decide <b>{p}</b></span>
          </div>
        </div>
        {showWhole && (
          <div className="rv-whole">
            <p>One decision and one comment for the whole plan — every line takes it.</p>
            {wholePlan}
          </div>
        )}
      </div>

      <div className="rv-layout">
        <div className="rv-main">
          <div className="bp-card rv-toolbar" role="group" aria-label="Filter lines">
            {chip('all', 'All', lines.length)}
            {chip('pending', 'To decide', p)}
            {chip('approve', 'Approved', a)}
            {chip('rework', 'Rework', w)}
            {chip('reject', 'Rejected', r)}
            {chip('flag', '⚑ Needs a look', lines.filter(flagged).length)}
            <input className="rv-search" value={q} onChange={(e) => setQ(e.target.value)} placeholder={`Search ${noun}…`} aria-label={`Search ${noun}`} />
          </div>

          <div className="bp-card rv-table-card">
            <div className="table-scroll">
              <table className="rv-table">
                <thead>
                  <tr>
                    <th className="rv-check">
                      <input
                        type="checkbox"
                        checked={allShownSelected}
                        onChange={() => setSel(allShownSelected ? new Set() : new Set(shown.map((l) => l.lineId)))}
                        aria-label="Select every line shown"
                      />
                    </th>
                    <th>{noun === 'product' ? 'Product' : 'Material'}</th>
                    <th>Route · qty</th>
                    <th className="num">Qty</th>
                    <th className="num">Value</th>
                    <th className="num">Share</th>
                    <th>Your decision</th>
                  </tr>
                </thead>
                <tbody>
                  {shown.map((l) => {
                    const d = current(l);
                    const isStaged = l.lineId in staged && staged[l.lineId] !== saved(l.lineStatus);
                    const share = l.value && total ? (l.value / total) * 100 : 0;
                    const note = noteOf(l);
                    return [
                      <tr key={l.lineId} className={`rv-line${sel.has(l.lineId) ? ' sel' : ''}${d ? ` d-${d}` : ''}`}>
                        <td className="rv-check">
                          <input
                            type="checkbox"
                            checked={sel.has(l.lineId)}
                            onChange={() =>
                              setSel((s) => {
                                const n = new Set(s);
                                if (n.has(l.lineId)) n.delete(l.lineId);
                                else n.add(l.lineId);
                                return n;
                              })
                            }
                            aria-label={`Select ${l.code}`}
                          />
                        </td>
                        <td>
                          <span className="mono rv-code">{l.code}</span>
                          {l.flags.npd && <span className="pl-tag npd">NPD</span>}
                          {l.flags.nocost && <span className="pl-tag nocost">No approved cost</span>}
                          {isStaged && <span className="rv-staged">not saved</span>}
                          <span className="rv-sub">{l.sub}</span>
                          {d && d !== 'approve' && note && openReason !== l.lineId && (
                            <span className="rv-note">
                              {d === 'rework' ? 'Rework' : 'Rejected'}: <b>{note}</b>
                              <button type="button" className="rv-link" onClick={() => setOpenReason(l.lineId)}>edit</button>
                            </span>
                          )}
                        </td>
                        <td>
                          <span className="rv-routes">
                            {l.routes.filter((x) => x.qty > 0).map((x) => (
                              <span key={x.label} className={`rv-route ${x.kind}`}>{x.label} {fmt.format(x.qty)}</span>
                            ))}
                          </span>
                        </td>
                        <td className="num">{l.qtyText}</td>
                        <td className="num">{l.value != null ? inr(l.value) : '—'}</td>
                        <td className="num">
                          <span className="rv-share">
                            {share ? `${share.toFixed(1)}%` : '—'}
                            <i style={{ ['--w' as string]: `${Math.min(100, share * 3)}%` }} />
                          </span>
                        </td>
                        <td>
                          <span className="rv-seg" role="group" aria-label={`Decision for ${l.code}`}>
                            <button type="button" className="ap" aria-pressed={d === 'approve'} onClick={() => decide(l, 'approve')}>
                              <Check size={13} /> Approve
                            </button>
                            <button type="button" className="rw" aria-pressed={d === 'rework'} onClick={() => decide(l, 'rework')} title="Send back for rework" aria-label={`Send ${l.code} back for rework`}>
                              <RotateCcw size={13} />
                            </button>
                            <button type="button" className="rj" aria-pressed={d === 'reject'} onClick={() => decide(l, 'reject')} title="Reject" aria-label={`Reject ${l.code}`}>
                              <X size={13} />
                            </button>
                          </span>
                        </td>
                      </tr>,
                      openReason === l.lineId && d && d !== 'approve' ? (
                        <tr key={`${l.lineId}-reason`} className="rv-reason">
                          <td colSpan={7}>
                            <label htmlFor={`rv-r-${l.lineId}`}>{d === 'rework' ? `What should change on ${l.code}?` : `Why reject ${l.code}?`}</label>
                            <div className="rv-quick">
                              {QUICK[d].map((t) => (
                                <button key={t} type="button" onClick={() => setNotes((n) => ({ ...n, [l.lineId]: t }))}>{t}</button>
                              ))}
                            </div>
                            <div className="rv-reason-row">
                              <input
                                id={`rv-r-${l.lineId}`}
                                autoFocus
                                value={note}
                                onChange={(e) => setNotes((n) => ({ ...n, [l.lineId]: e.target.value }))}
                                onKeyDown={(e) => {
                                  if (e.key === 'Enter' && note.trim()) setOpenReason(null);
                                }}
                                placeholder="A reason the team will see"
                              />
                              <button type="button" className="wf-btn wf-btn-primary wf-btn-sm" disabled={!note.trim()} onClick={() => setOpenReason(null)}>Done</button>
                              <button
                                type="button"
                                className="wf-btn wf-btn-ghost wf-btn-sm"
                                onClick={() => {
                                  if (!note.trim()) setStaged((s) => ({ ...s, [l.lineId]: saved(l.lineStatus) }));
                                  setOpenReason(null);
                                }}
                              >
                                Cancel
                              </button>
                            </div>
                          </td>
                        </tr>
                      ) : null,
                    ];
                  })}
                  {!shown.length && (
                    <tr>
                      <td colSpan={7} className="wf-empty-cell">{filter === 'pending' ? 'Every line has a decision.' : 'No lines match.'}</td>
                    </tr>
                  )}
                </tbody>
              </table>
            </div>
          </div>
        </div>

        <aside className="rv-side">
          <section className="bp-card">
            <div className="bp-cardhead"><h2>If you confirm now</h2></div>
            <div className="bp-cardbody"><div className={`rv-outcome ${outcome.tone}`}><b>{outcome.title}</b>{outcome.body}</div></div>
          </section>
          <section className="bp-card">
            <div className="bp-cardhead"><h2>Value by route</h2><span className="bp-badge gray">{inr(routeSum)}</span></div>
            <div className="bp-cardbody rv-rows">
              {routeTotals.map((x) => (
                <div key={x.label} className="rv-row">
                  <span>{x.label}{noun === 'product' ? ` · ${fmt.format(x.qty)} pcs` : ''}</span>
                  <b>{x.value ? inr(x.value) : '—'}</b>
                  <div className="rv-mini"><i style={{ width: `${routeSum ? (x.value / routeSum) * 100 : 0}%` }} /></div>
                </div>
              ))}
            </div>
          </section>
          <section className="bp-card">
            <div className="bp-cardhead"><h2>Value by {groupLabel}</h2></div>
            <div className="bp-cardbody rv-rows">
              {groups.map((x) => (
                <div key={x.g} className="rv-row">
                  <span>{x.g}</span>
                  <b>{x.value ? inr(x.value) : '—'}</b>
                  <div className="rv-mini"><i style={{ width: `${routeSum ? (x.value / routeSum) * 100 : 0}%` }} /></div>
                </div>
              ))}
            </div>
          </section>
          <section className="bp-card">
            <div className="bp-cardhead"><h2>Worth a second look</h2></div>
            <div className="bp-cardbody rv-rows">
              {flagRows.map(([t, ls]) => (
                <div key={t} className="rv-flag">
                  <div className="rv-row"><span>{t}</span><b>{ls.length}</b></div>
                  {ls.length > 0 && <small>{ls.map((l) => l.code).join(', ')}</small>}
                </div>
              ))}
              <button type="button" className="wf-btn wf-btn-ghost wf-btn-sm" onClick={() => setFilter('flag')}>Show these lines</button>
            </div>
          </section>
        </aside>
      </div>

      {sel.size > 0 && (
        <div className="rv-bulk" role="region" aria-label="Selected lines">
          <span><b>{sel.size}</b> selected · {inr(lines.filter((l) => sel.has(l.lineId)).reduce((s, l) => s + (l.value ?? 0), 0))}</span>
          <button type="button" onClick={() => bulk('approve')}><Check size={13} /> Approve</button>
          <button type="button" onClick={() => bulk('rework')}><RotateCcw size={13} /> Rework</button>
          <button type="button" onClick={() => bulk('reject')}><X size={13} /> Reject</button>
          <button type="button" onClick={() => setSel(new Set())}>Clear</button>
        </div>
      )}
      {changes.length > 0 && (
        <div className="rv-confirm" role="region" aria-label="Decisions not saved yet">
          <span>
            <b>{changes.length} decision{changes.length === 1 ? '' : 's'}</b> ready ·{' '}
            {changes.filter((l) => staged[l.lineId] === 'approve').length} approve ·{' '}
            {changes.filter((l) => staged[l.lineId] === 'rework').length} rework ·{' '}
            {changes.filter((l) => staged[l.lineId] === 'reject').length} reject
          </span>
          {error && <span className="rv-error">{error}</span>}
          <button type="button" className="wf-btn wf-btn-ghost wf-btn-sm" disabled={pending} onClick={() => { setStaged({}); setNotes({}); setOpenReason(null); setError(null); }}>
            Undo all
          </button>
          <button type="button" className="wf-btn wf-btn-primary" disabled={pending} onClick={confirm}>
            {pending ? 'Saving…' : 'Confirm decisions'}
          </button>
        </div>
      )}
    </section>
  );
}

