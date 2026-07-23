import { daysBetween, parseIsoDate } from './business-logic';
import type { TnaRecord } from './types';

/**
 * TNA critical path.
 *
 * Replaces `isHighRiskPo` in business-logic.ts, which flagged risk from EDD
 * proximity plus a nil-receipt check. That is not the rule: a PO is high risk
 * when ANY critical-path milestone is past its TNA date and still not actioned,
 * regardless of how far away delivery is. A PP sample due today and approved
 * tomorrow pushes delivery by a day even if delivery is a month out — surfacing
 * it early is the whole point.
 *
 * Delay is always computed as-on-today. The `*_delay_days` columns coming off
 * the sheet are stale formula output and are deliberately ignored.
 */

export const CRITICAL_PATH = [
  { key: 'pp_sample', label: 'PP Sample', due: 'pp_sample_tna_date', actual: 'pp_sample_actual_date' },
  { key: 'gpt', label: 'GPT', due: 'gpt_tna_date', actual: 'gpt_actual_date' },
  { key: 'cutting', label: 'Cutting', due: 'cutting_tna_date', actual: 'cutting_actual_date_first' },
  { key: 'inline_qc', label: 'Inline QC', due: 'in_line_tna_date', actual: 'in_line_actual_date' },
] as const;

export type CriticalPathBreach = {
  key: string;
  label: string;
  dueDate: string;
  daysLate: number;
};

export type CriticalPathResult = {
  highRisk: boolean;
  breaches: CriticalPathBreach[];
  maxDelayDays: number;
  /** Milestone the PO is currently sitting on, or null when all are done. */
  currentStage: string | null;
  inTracker: boolean;
};

export function tnaCriticalPath(
  tna: TnaRecord | null | undefined,
  today = new Date(),
): CriticalPathResult {
  if (!tna) {
    return {
      highRisk: false,
      breaches: [],
      maxDelayDays: 0,
      currentStage: null,
      inTracker: false,
    };
  }

  const breaches: CriticalPathBreach[] = [];
  let currentStage: string | null = null;

  for (const stage of CRITICAL_PATH) {
    const actual = tna[stage.actual as keyof TnaRecord] as string | null;
    if (actual) continue; // milestone complete — never a breach

    if (!currentStage) currentStage = stage.label;

    const due = parseIsoDate(tna[stage.due as keyof TnaRecord] as string | null);
    if (!due) continue; // no committed date to breach

    const daysLate = daysBetween(today, due);
    if (daysLate > 0) {
      breaches.push({
        key: stage.key,
        label: stage.label,
        dueDate: tna[stage.due as keyof TnaRecord] as string,
        daysLate,
      });
    }
  }

  return {
    highRisk: breaches.length > 0,
    breaches,
    maxDelayDays: breaches.reduce((max, b) => Math.max(max, b.daysLate), 0),
    currentStage,
    inTracker: true,
  };
}

/** Convenience wrapper for table cells and badges. */
export function riskLabel(result: CriticalPathResult): string {
  if (!result.inTracker) return 'Not in TNA tracker';
  if (!result.highRisk) return 'On track';
  const worst = result.breaches[0];
  return result.breaches.length === 1
    ? `${worst.label} · ${worst.daysLate}d late`
    : `${result.breaches.length} stages late · max ${result.maxDelayDays}d`;
}
