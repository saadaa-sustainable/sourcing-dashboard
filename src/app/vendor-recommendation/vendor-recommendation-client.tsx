'use client';

import { useMemo, useState } from 'react';
import { Notice } from '@/components/forms/form-layout';
import type { VendorRecommendationRow } from '@/lib/forms/types';

// Scoring — tune these two weights (they sum to 1). On-time is scored over the
// RATED completed POs (those with both an EDD and a GRN receipt date) so a vendor
// is never penalised for our missing data; coverage is surfaced separately.
const WEIGHTS = { onTime: 0.6, completion: 0.4 };
// A vendor needs at least this many POs given to be ranked; fewer = "thin data".
const MIN_POS = 5;
// QC-fail return penalty: points removed from the score per 1% QC-fail, applied
// only when the vendor has enough attributed returned items to be reliable.
const QC_PENALTY_PER_PCT = 3;
const MIN_QC_RETURNS = 20;
// Inbound-QC rejection penalty. Reject rates run much higher (over the QC-checked
// subset, which is selective), so the per-% penalty is smaller. Applied only with
// enough QC-checked units.
const REJECT_PENALTY_PER_PCT = 0.5;
const MIN_QC_CHECKED = 50;

const round1 = (v: number) => Math.round(v * 10) / 10;
const pct = (v: number | null) => (v == null ? '—' : `${v}%`);

type Scored = VendorRecommendationRow & {
  rated: number;
  onTimeRated: number | null;
  coverage: number | null; // rated / completed
  qcPenalty: number; // points removed for QC-fail (0 if too few returns / no data)
  rejectPenalty: number; // points removed for inbound-QC rejection
  score: number | null;
};

function scoreOf(r: VendorRecommendationRow): Scored {
  const rated = r.pos_completed - r.pos_completed_unrated;
  const onTimeRated = rated > 0 ? round1((r.pos_on_time / rated) * 100) : null;
  const coverage = r.pos_completed > 0 ? Math.round((rated / r.pos_completed) * 100) : null;
  const comp = r.completion_rate_pct;
  const base =
    onTimeRated != null && comp != null
      ? WEIGHTS.onTime * onTimeRated + WEIGHTS.completion * comp
      : null;
  // Penalise QC-fail only with enough returned items to trust the rate.
  const qcPenalty =
    (r.qc_returned_items ?? 0) >= MIN_QC_RETURNS && r.qc_fail_rate_pct != null
      ? round1(r.qc_fail_rate_pct * QC_PENALTY_PER_PCT)
      : 0;
  // Penalise inbound-QC rejection only with enough QC-checked units.
  const rejectPenalty =
    (r.grn_qc_checked ?? 0) >= MIN_QC_CHECKED && r.grn_reject_rate_pct != null
      ? round1(r.grn_reject_rate_pct * REJECT_PENALTY_PER_PCT)
      : 0;
  const score = base != null ? Math.max(0, Math.round(base - qcPenalty - rejectPenalty)) : null;
  return { ...r, rated, onTimeRated, coverage, qcPenalty, rejectPenalty, score };
}

const scoreTone = (s: number | null) =>
  s == null ? 'wf-subtle' : s >= 70 ? 'success' : s >= 45 ? 'info' : 'warn';
const confidence = (c: number | null) =>
  c == null ? '—' : c >= 80 ? 'High' : c >= 50 ? 'Medium' : 'Low';

type SortKey = 'score' | 'completion' | 'onTime' | 'delay' | 'qcFail' | 'reject' | 'pos' | 'recent';
const SORT_LABEL: Record<SortKey, string> = {
  score: 'Score', completion: 'Completion', onTime: 'On-time',
  delay: 'Delay', qcFail: 'QC-fail', reject: 'Rejection', pos: 'POs given', recent: 'Last PO',
};
// Value to sort on; higher = better/first, so Delay and QC-fail are negated (lower is better).
const sortVal = (v: Scored, k: SortKey): number | string =>
  k === 'score' ? (v.score ?? -1)
  : k === 'completion' ? (v.completion_rate_pct ?? -1)
  : k === 'onTime' ? (v.on_time_rate_pct ?? -1)
  : k === 'delay' ? -(v.delay_rate_pct ?? 999)
  : k === 'qcFail' ? -(v.qc_fail_rate_pct ?? -1)
  : k === 'reject' ? -(v.grn_reject_rate_pct ?? -1)
  : k === 'pos' ? v.pos_given
  : (v.last_po_date ?? '');

// Column headers for the ranked table; `key` set = click-to-sort by that column.
const HEADERS: { label: string; key?: SortKey; cls?: string }[] = [
  { label: '#', cls: 'num' },
  { label: 'Vendor' },
  { label: 'Score', key: 'score', cls: 'num' },
  { label: 'Completion', key: 'completion', cls: 'num' },
  { label: 'On-time', key: 'onTime', cls: 'num' },
  { label: 'Delay', key: 'delay', cls: 'num' },
  { label: 'QC-fail', key: 'qcFail', cls: 'num' },
  { label: 'Rejection', key: 'reject', cls: 'num' },
  { label: 'Confidence', cls: 'num' },
  { label: 'POs', key: 'pos', cls: 'num' },
  { label: 'Last PO', key: 'recent', cls: 'num' },
];

export function VendorRecommendationClient({ rows }: { rows: VendorRecommendationRow[] }) {
  const [q, setQ] = useState('');
  const [showThin, setShowThin] = useState(false);
  const [sortKey, setSortKey] = useState<SortKey>('score');
  const [minPos, setMinPos] = useState(MIN_POS);

  const scored = useMemo(() => rows.map(scoreOf), [rows]);
  const filtered = useMemo(() => {
    const term = q.trim().toLowerCase();
    return scored.filter((v) =>
      !term || `${v.vendor_code ?? ''} ${v.vendor_name ?? ''}`.toLowerCase().includes(term),
    );
  }, [scored, q]);

  const cmp = (a: Scored, b: Scored) => {
    const av = sortVal(a, sortKey), bv = sortVal(b, sortKey);
    if (av < bv) return 1;
    if (av > bv) return -1;
    return b.pos_given - a.pos_given;
  };
  const ranked = useMemo(
    () => filtered.filter((v) => v.pos_given >= minPos).sort(cmp),
    [filtered, sortKey, minPos],
  );
  const thin = useMemo(
    () => filtered.filter((v) => v.pos_given < minPos).sort((a, b) => b.pos_given - a.pos_given),
    [filtered, minPos],
  );

  return (
    <>
      <Notice tone="info">
        <strong>Score</strong> = {WEIGHTS.onTime} × on-time(rated) + {WEIGHTS.completion} × completion −{' '}
        {QC_PENALTY_PER_PCT} × QC-fail% − {REJECT_PENALTY_PER_PCT} × Rejection%, out of 100.{' '}
        <strong>On-time</strong> counts POs received (GRN date) on/before their EDD, over the{' '}
        <strong>rated</strong> completed POs. <strong>QC-fail</strong> = share of customer-returned items
        that came back defective (return quality). <strong>Rejection</strong> = share of goods that failed
        inbound QC at receipt (qc_fail ÷ qc-checked) — the direct vendor-quality signal, but it reflects
        the QC-checked subset (QC is selective), so treat high rates as a flag, not an absolute. Each
        penalty applies only above its reliability threshold. Hover any figure for detail; vendors with
        fewer than {MIN_POS} POs are listed separately as thin data.
      </Notice>

      <div className="wf-toolbar wf-filter-bar">
        <input
          className="wf-search"
          placeholder="Filter vendor / code…"
          value={q}
          onChange={(e) => setQ(e.target.value)}
        />
        <label className="wf-inline-field">
          Sort
          <select value={sortKey} onChange={(e) => setSortKey(e.target.value as SortKey)}>
            {(Object.keys(SORT_LABEL) as SortKey[]).map((k) => (
              <option key={k} value={k}>{SORT_LABEL[k]}</option>
            ))}
          </select>
        </label>
        <label className="wf-inline-field">
          Min POs
          <input
            type="number"
            min={1}
            value={minPos}
            onChange={(e) => setMinPos(Math.max(1, Number(e.target.value) || 1))}
            style={{ width: 64 }}
          />
        </label>
        <span className="wf-chip">{ranked.length} ranked</span>
        <label className="wf-check">
          <input type="checkbox" checked={showThin} onChange={(e) => setShowThin(e.target.checked)} />
          Show thin data ({thin.length})
        </label>
      </div>

      <div className="table-panel wf-grid-panel">
        <div className="table-scroll">
          <table className="wide-table wf-grid vr-grid">
            <thead>
              <tr>
                {HEADERS.map((h) => (
                  <th
                    key={h.label}
                    className={h.cls}
                    style={h.key ? { cursor: 'pointer', userSelect: 'none' } : undefined}
                    title={h.key ? `Sort by ${h.label}` : undefined}
                    onClick={h.key ? () => setSortKey(h.key!) : undefined}
                  >
                    {h.label}
                    {h.key === sortKey ? ' ▾' : ''}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {ranked.map((v, i) => (
                <VendorRow key={v.vendor_key} v={v} rank={i + 1} />
              ))}
              {!ranked.length && (
                <tr>
                  <td colSpan={11} className="wf-empty-cell">No vendors match.</td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </div>

      {showThin && thin.length > 0 && (
        <div className="table-panel wf-grid-panel">
          <div className="table-meta">
            <h3>Thin data — under {MIN_POS} POs given</h3>
            <span>Not ranked; too few POs to judge reliability.</span>
          </div>
          <div className="table-scroll">
            <table className="wide-table wf-grid vr-grid">
              <thead>
                <tr>
                  <th>Vendor</th>
                  <th className="num">Completion</th>
                  <th className="num">On-time</th>
                  <th className="num">Delay</th>
                  <th className="num">POs</th>
                </tr>
              </thead>
              <tbody>
                {thin.map((v) => (
                  <tr key={v.vendor_key}>
                    <td>{v.vendor_name || v.vendor_key}</td>
                    <td className="num" title={`${v.pos_completed} completed of ${v.pos_given} given`}>{pct(v.completion_rate_pct)}</td>
                    <td className="num" title={onTimeTitle(v)}>{pct(v.on_time_rate_pct)}</td>
                    <td className="num" title={`${v.pos_delayed} delayed of ${v.rated} rated`}>{pct(v.delay_rate_pct)}</td>
                    <td className="num">{v.pos_completed} / {v.pos_given}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </>
  );
}

function onTimeTitle(v: Scored): string {
  return (
    `${v.pos_on_time} on-time of ${v.rated} rated completed PO(s)` +
    ` · ${v.pos_completed_unrated} of ${v.pos_completed} completed are unrated (no EDD or GRN date)` +
    (v.coverage != null ? ` · covers ${v.coverage}% of completions` : '')
  );
}

function VendorRow({ v, rank }: { v: Scored; rank: number }) {
  return (
    <tr>
      <td className="num strong">{rank}</td>
      <td>
        <span className="mono">{v.vendor_code || '—'}</span>
        <small className="wf-subtle">{v.vendor_name}</small>
      </td>
      <td className="num">
        <span
          className={`badge ${scoreTone(v.score)}`}
          title={
            v.score != null
              ? `${WEIGHTS.onTime} × on-time(rated) ${v.onTimeRated}% + ${WEIGHTS.completion} × completion ${v.completion_rate_pct}%` +
                (v.qcPenalty > 0 ? ` − ${v.qcPenalty} QC-fail penalty` : '') +
                (v.rejectPenalty > 0 ? ` − ${v.rejectPenalty} rejection penalty` : '')
              : 'Not enough rated data to score'
          }
        >
          {v.score ?? '—'}
        </span>
      </td>
      <td className="num" title={`${v.pos_completed} completed of ${v.pos_given} given`}>
        {pct(v.completion_rate_pct)}
      </td>
      <td className="num" title={onTimeTitle(v)}>{pct(v.on_time_rate_pct)}</td>
      <td className="num" title={`${v.pos_delayed} delayed of ${v.rated} rated`}>
        {pct(v.delay_rate_pct)}
      </td>
      <td
        className="num"
        title={
          v.qc_returned_items
            ? `${v.qc_fail_items} defective of ${v.qc_returned_items} returned item(s)` +
              (v.qcPenalty > 0 ? ` · −${v.qcPenalty} to score` : ` · below ${MIN_QC_RETURNS}-return threshold, no penalty`)
            : 'No returns attributed to this vendor'
        }
      >
        {v.qc_fail_rate_pct != null ? (
          <span className={v.qcPenalty > 0 ? 'wf-error-text' : undefined}>{v.qc_fail_rate_pct}%</span>
        ) : '—'}
      </td>
      <td
        className="num"
        title={
          v.grn_qc_checked
            ? `inbound QC-checked ${v.grn_qc_checked} unit(s)` +
              (v.rejectPenalty > 0 ? ` · −${v.rejectPenalty} to score` : ` · below ${MIN_QC_CHECKED}-checked threshold, no penalty`)
            : 'No QC-checked GRNs for this vendor'
        }
      >
        {v.grn_reject_rate_pct != null ? (
          <span className={v.rejectPenalty > 0 ? 'wf-error-text' : undefined}>{v.grn_reject_rate_pct}%</span>
        ) : '—'}
      </td>
      <td className="num" title={v.coverage != null ? `${v.rated} of ${v.pos_completed} completed POs are rated` : 'No rated completions'}>
        <span className={v.coverage != null && v.coverage < 50 ? 'wf-error-text' : undefined}>
          {confidence(v.coverage)}
        </span>
        {v.coverage != null && <small className="wf-subtle">{v.coverage}%</small>}
      </td>
      <td className="num">{v.pos_completed} / {v.pos_given}</td>
      <td className="num wf-subtle">{v.last_po_date ?? '—'}</td>
    </tr>
  );
}
