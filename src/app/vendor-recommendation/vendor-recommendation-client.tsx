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

const round1 = (v: number) => Math.round(v * 10) / 10;
const pct = (v: number | null) => (v == null ? '—' : `${v}%`);

type Scored = VendorRecommendationRow & {
  rated: number;
  onTimeRated: number | null;
  coverage: number | null; // rated / completed
  score: number | null;
};

function scoreOf(r: VendorRecommendationRow): Scored {
  const rated = r.pos_completed - r.pos_completed_unrated;
  const onTimeRated = rated > 0 ? round1((r.pos_on_time / rated) * 100) : null;
  const coverage = r.pos_completed > 0 ? Math.round((rated / r.pos_completed) * 100) : null;
  const comp = r.completion_rate_pct;
  const score =
    onTimeRated != null && comp != null
      ? Math.round(WEIGHTS.onTime * onTimeRated + WEIGHTS.completion * comp)
      : null;
  return { ...r, rated, onTimeRated, coverage, score };
}

const scoreTone = (s: number | null) =>
  s == null ? 'wf-subtle' : s >= 70 ? 'success' : s >= 45 ? 'info' : 'warn';
const confidence = (c: number | null) =>
  c == null ? '—' : c >= 80 ? 'High' : c >= 50 ? 'Medium' : 'Low';

export function VendorRecommendationClient({ rows }: { rows: VendorRecommendationRow[] }) {
  const [q, setQ] = useState('');
  const [showThin, setShowThin] = useState(false);

  const scored = useMemo(() => rows.map(scoreOf), [rows]);
  const filtered = useMemo(() => {
    const term = q.trim().toLowerCase();
    return scored.filter((v) =>
      !term || `${v.vendor_code ?? ''} ${v.vendor_name ?? ''}`.toLowerCase().includes(term),
    );
  }, [scored, q]);

  const ranked = useMemo(
    () =>
      filtered
        .filter((v) => v.pos_given >= MIN_POS)
        .sort((a, b) => (b.score ?? -1) - (a.score ?? -1) || b.pos_given - a.pos_given),
    [filtered],
  );
  const thin = useMemo(
    () => filtered.filter((v) => v.pos_given < MIN_POS).sort((a, b) => b.pos_given - a.pos_given),
    [filtered],
  );

  return (
    <>
      <Notice tone="info">
        <strong>Score</strong> = {WEIGHTS.onTime} × on-time(rated) + {WEIGHTS.completion} × completion,
        out of 100. <strong>On-time</strong> counts POs received (GRN date) on/before their expected
        delivery date, over the <strong>rated</strong> completed POs (those with both an EDD and a GRN
        date). Hover any rate to see its coverage — a low <strong>confidence</strong> means many
        completed POs are unrated, so treat that vendor’s rates with caution. Vendors with fewer than{' '}
        {MIN_POS} POs are listed separately as thin data.
      </Notice>

      <div className="wf-toolbar wf-filter-bar">
        <input
          className="wf-search"
          placeholder="Filter vendor / code…"
          value={q}
          onChange={(e) => setQ(e.target.value)}
        />
        <span className="wf-chip">{ranked.length} ranked</span>
        <label className="wf-check">
          <input type="checkbox" checked={showThin} onChange={(e) => setShowThin(e.target.checked)} />
          Show thin data ({thin.length})
        </label>
      </div>

      <div className="table-panel wf-grid-panel">
        <div className="table-scroll">
          <table className="wide-table wf-grid">
            <thead>
              <tr>
                <th className="num">#</th>
                <th>Vendor</th>
                <th className="num">Score</th>
                <th className="num">Completion</th>
                <th className="num">On-time</th>
                <th className="num">Delay</th>
                <th className="num">Confidence</th>
                <th className="num">POs (done / given)</th>
                <th className="num">Last PO</th>
              </tr>
            </thead>
            <tbody>
              {ranked.map((v, i) => (
                <VendorRow key={v.vendor_key} v={v} rank={i + 1} />
              ))}
              {!ranked.length && (
                <tr>
                  <td colSpan={9} className="wf-empty-cell">No vendors match.</td>
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
            <table className="wide-table wf-grid">
              <thead>
                <tr>
                  <th>Vendor</th>
                  <th className="num">Completion</th>
                  <th className="num">On-time</th>
                  <th className="num">Delay</th>
                  <th className="num">POs (done / given)</th>
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
              ? `${WEIGHTS.onTime} × on-time(rated) ${v.onTimeRated}% + ${WEIGHTS.completion} × completion ${v.completion_rate_pct}%`
              : 'Not enough rated data to score'
          }
        >
          {v.score ?? '—'}
        </span>
      </td>
      <td className="num" title={`${v.pos_completed} completed of ${v.pos_given} given`}>
        {pct(v.completion_rate_pct)}
      </td>
      <td className="num" title={onTimeTitle(v)}>
        {pct(v.on_time_rate_pct)}
        {v.coverage != null && v.coverage < 50 && <small className="wf-over-tag">low cover</small>}
      </td>
      <td className="num" title={`${v.pos_delayed} delayed of ${v.rated} rated`}>
        {pct(v.delay_rate_pct)}
      </td>
      <td className="num" title={v.coverage != null ? `${v.rated} of ${v.pos_completed} completed POs are rated` : 'No rated completions'}>
        {confidence(v.coverage)}
        {v.coverage != null && <small className="wf-subtle">{v.coverage}%</small>}
      </td>
      <td className="num">{v.pos_completed} / {v.pos_given}</td>
      <td className="num wf-subtle">{v.last_po_date ?? '—'}</td>
    </tr>
  );
}
