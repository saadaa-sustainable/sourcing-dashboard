'use client';

import { useState } from 'react';
import { FileDown, Lock } from 'lucide-react';
import { toastError } from '@/lib/toast';
import {
  downloadVariationPdf,
  fmtDiff,
  fmtPct,
  fmtValue,
  statusWord,
  variance,
  type VarianceStatus,
  type VariationReport,
} from '@/lib/variation-report';

const TONE: Record<VarianceStatus, string> = {
  on_plan: 'is-ok',
  over: 'is-over',
  short: 'is-short',
  unplanned: 'is-over',
  no_actual: 'is-muted',
  none: 'is-muted',
};

/** Rows shown per section before "Show all". */
const FIRST = 12;

/**
 * The Variation Report of a closed document — planned vs actual, built when the page opens,
 * downloadable as a PDF. Shown at the top of every closed Buying Plan month, frozen Standard
 * Cost, past Vendor Capacity week and closed Inward Plan month.
 */
export function VariationReportPanel({ report }: { report: VariationReport }) {
  const [busy, setBusy] = useState(false);
  const [expanded, setExpanded] = useState<Record<number, boolean>>({});

  async function download() {
    setBusy(true);
    try {
      await downloadVariationPdf(report);
    } catch {
      toastError('The PDF could not be built. Try again.');
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="vr" aria-label="Variation Report">
      <div className="vr-head">
        <div className="vr-title">
          <span className="vr-closed">
            <Lock size={12} aria-hidden="true" /> Closed
          </span>
          <h2>Variation Report</h2>
          <span className="vr-period">
            {report.period} · {report.closedNote}
          </span>
        </div>
        <button type="button" className="wf-btn wf-btn-primary wf-btn-sm" onClick={download} disabled={busy}>
          <FileDown size={14} aria-hidden="true" /> {busy ? 'Building…' : 'Download PDF'}
        </button>
      </div>

      {report.tiles.length > 0 && (
        <div className="vr-tiles">
          {report.tiles.map((t) => {
            const v = variance(t.planned, t.actual, t.pctMode);
            return (
              <div key={t.label} className={`vr-tile ${TONE[v.status]}`}>
                <span className="vr-tile-label">{t.label}</span>
                <div className="vr-tile-pair">
                  <span>
                    <small>Planned</small>
                    <b>{fmtValue(t.planned, t.unit)}</b>
                  </span>
                  <span>
                    <small>Actual</small>
                    <b>{fmtValue(t.actual, t.unit)}</b>
                  </span>
                </div>
                <span className="vr-tile-var">
                  {fmtDiff(v, t.unit)}
                  {v.pct != null && <em> · {fmtPct(v, t.pctMode)}</em>}
                  <span className="vr-status">{statusWord(v.status, t.words)}</span>
                </span>
              </div>
            );
          })}
        </div>
      )}

      {report.missing && <p className="vr-missing">{report.missing}</p>}

      <ul className="vr-basis">
        {report.basis.map((b) => (
          <li key={b}>{b}</li>
        ))}
      </ul>

      {report.sections.map((s, si) => {
        const all = expanded[si] ?? false;
        const rows = all ? s.rows : s.rows.slice(0, FIRST);
        return (
          <details key={s.title} className="vr-section" open={si === 0}>
            <summary>
              {s.title} <span className="vr-count">{s.rows.length}</span>
            </summary>
            <div className="table-scroll">
              <table className="wf-grid vr-table">
                <thead>
                  <tr>
                    <th />
                    <th className="num">{s.plannedLabel}</th>
                    <th className="num">{s.actualLabel}</th>
                    <th className="num">Variation</th>
                    <th className="num">%</th>
                    <th>Status</th>
                  </tr>
                </thead>
                <tbody>
                  {rows.map((row) => {
                    const v = variance(row.planned, row.actual, s.pctMode);
                    return (
                      <tr key={row.key}>
                        <td>
                          <span className="vr-row-name">{row.name}</span>
                          {(row.sub || row.note) && <small className="vr-row-sub">{[row.sub, row.note].filter(Boolean).join(' · ')}</small>}
                        </td>
                        <td className="num">{fmtValue(row.planned, s.unit)}</td>
                        <td className="num">{fmtValue(row.actual, s.unit)}</td>
                        <td className="num">{fmtDiff(v, s.unit)}</td>
                        <td className="num">{fmtPct(v, s.pctMode)}</td>
                        <td>
                          <span className={`vr-status ${TONE[v.status]}`}>{statusWord(v.status, s.words)}</span>
                        </td>
                      </tr>
                    );
                  })}
                  {!s.rows.length && (
                    <tr>
                      <td colSpan={6} className="wf-empty-cell">{s.empty ?? 'Nothing to compare.'}</td>
                    </tr>
                  )}
                </tbody>
              </table>
            </div>
            {s.rows.length > FIRST && (
              <button type="button" className="wf-chip-btn vr-more" onClick={() => setExpanded((e) => ({ ...e, [si]: !all }))}>
                {all ? 'Show fewer' : `Show all ${s.rows.length}`}
              </button>
            )}
          </details>
        );
      })}
    </section>
  );
}
