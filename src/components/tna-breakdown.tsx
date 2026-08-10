"use client";

import { Fragment } from "react";
import { FileText } from "lucide-react";
import { stageDelay } from "@/lib/business-logic";
import type { StageInspection, TnaRecord, TrackerRow } from "@/lib/types";

// The five stages shown in the inline breakdown (First Delivery / PDI excluded per
// product decision). `token` matches sd_po_stage_inspections' stage keys, and
// tna/actual are the TnaRecord date fields for the planned vs actual columns.
const STAGES = [
  { name: "PP Sample", token: "pp", tna: "pp_sample_tna_date", actual: "pp_sample_actual_date" },
  { name: "GPT", token: "gpt", tna: "gpt_tna_date", actual: "gpt_actual_date" },
  { name: "Cutting", token: "cutting", tna: "cutting_tna_date", actual: "cutting_actual_date_first" },
  { name: "Inline / Midline QC", token: "inline", tna: "in_line_tna_date", actual: "in_line_actual_date" },
  { name: "PO Closer", token: "closer", tna: "po_closer_tna_date", actual: "po_closer_actual_date" },
] as const;

const dateField = (tna: TnaRecord | null, field: string): string | null =>
  (tna?.[field as keyof TnaRecord] as string | null | undefined) ?? null;

function DeltaBadge({ planned, actual }: { planned: string | null; actual: string | null }) {
  const { state, days } = stageDelay(planned, actual);
  if (state === "None") return <>—</>;
  if (state === "Pending") return <span className="badge info">Pending</span>;
  if (state === "Delay") return <span className="badge danger">Delay {days}d</span>;
  return <span className="badge success">{days ? `On Time · ${days}d early` : "On Time"}</span>;
}

// "3 inspections · 2 fail → pass" (total attempts, fails highlighted). The pass is
// implied once the stage has an actual/pass date; otherwise fails are "no pass yet".
function inspectionSummary(insp: StageInspection, hasPass: boolean) {
  const attempts = `${insp.count} inspection${insp.count === 1 ? "" : "s"}`;
  if (!insp.failCount) return hasPass ? `${attempts} · passed` : attempts;
  return `${attempts} · ${insp.failCount} fail${hasPass ? " → pass" : " (no pass yet)"}`;
}

function ReportLink({ url }: { url: string | null }) {
  if (!url) return <>—</>;
  return (
    <a className="tna-report-link" href={url} target="_blank" rel="noreferrer">
      <FileText size={12} /> Report
    </a>
  );
}

/** Inline 5-stage TNA breakdown: planned vs actual, on-time/delay, inspection count
 *  (fails → pass), and the form's inspection-report PDF link. Fail entries are listed
 *  beneath their stage as reference context. */
export function TnaBreakdown({ row }: { row: TrackerRow }) {
  return (
    <div className="tna-breakdown">
      {!row.tna && (
        <p className="tna-breakdown-note">No TNA timeline for this PO (not in the TNA Tracker).</p>
      )}
      <table className="tna-breakdown-table">
        <thead>
          <tr>
            <th>Stage</th>
            <th>Planned (TNA)</th>
            <th>Actual (pass)</th>
            <th>On-time / delay</th>
            <th>Inspections</th>
            <th>Report</th>
          </tr>
        </thead>
        <tbody>
          {STAGES.map((s) => {
            const planned = dateField(row.tna, s.tna);
            const actual = dateField(row.tna, s.actual);
            const insp = row.inspections?.[s.token];
            const fails = insp?.entries.filter((e) => e.result === "fail") ?? [];
            const hasPass = Boolean(actual) || Boolean(insp?.passDate) || (insp?.entries.some((e) => e.result === "pass") ?? false);
            return (
              <Fragment key={s.token}>
                <tr>
                  <td className="tna-stage-name">{s.name}</td>
                  <td>{planned ?? "—"}</td>
                  <td>{actual ?? "—"}</td>
                  <td><DeltaBadge planned={planned} actual={actual} /></td>
                  <td>{insp ? inspectionSummary(insp, hasPass) : "—"}</td>
                  <td><ReportLink url={insp?.reportUrl ?? null} /></td>
                </tr>
                {fails.map((e, i) => (
                  <tr className="tna-fail-row" key={`${s.token}-fail-${i}`}>
                    <td />
                    <td colSpan={5}>
                      <span className="badge danger">Fail</span>{" "}
                      {e.actualDate ?? e.submittedAt?.slice(0, 10) ?? "—"}
                      {e.remarks ? ` · ${e.remarks}` : ""}
                      {e.reportUrl ? (
                        <>
                          {" · "}
                          <a className="tna-report-link" href={e.reportUrl} target="_blank" rel="noreferrer">
                            <FileText size={12} /> report
                          </a>
                        </>
                      ) : null}
                    </td>
                  </tr>
                ))}
              </Fragment>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
