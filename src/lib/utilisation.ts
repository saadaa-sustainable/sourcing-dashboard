/**
 * How a capacity-utilisation figure is written, everywhere.
 *
 * USER RULE (stated repeatedly, most recently 2026-09-24): once utilisation is
 * past 100% the number stops being useful — 276%, 318.9% and 2,815% all mean the
 * same operational thing, and printing them makes a report look broken. Over 100%
 * we state the condition instead of the figure. Under 100% the number stays,
 * because there the exact value tells you how much room is left.
 *
 * This lives in one module on purpose: the rule was previously re-implemented in
 * four separate call sites and drifted out of sync in all of them (one even
 * carried a comment describing this rule while still rendering the raw number).
 * Render utilisation through these helpers — do not hand-roll `${pct}%` again.
 */

/** The exact wording the user asked for. Do not reword without asking. */
export const OVER_UTILISED = '100% Over Utilised';

/** True once the vendor is past its capacity. */
export function isOverUtilised(pct: number | null | undefined): boolean {
  return pct != null && Number.isFinite(pct) && pct > 100;
}

/**
 * Utilisation as it should be shown to a human — in the UI, and in the CSV/PDF
 * exports, which are read by the same people. `null`/non-finite renders as a dash.
 */
export function utilisationLabel(
  pct: number | null | undefined,
  dash = '—',
): string {
  if (pct == null || !Number.isFinite(pct)) return dash;
  if (isOverUtilised(pct)) return OVER_UTILISED;
  return `${Math.round(pct)}%`;
}
