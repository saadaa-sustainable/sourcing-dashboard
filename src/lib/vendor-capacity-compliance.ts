import { capacityWeekStart } from './forms/approval';

export type ComplianceMaster = { code: string; name: string; merchant: string; onboarding: string | null; status: string | null; isActive?: boolean; fallbackActive: boolean; deboardedAt?: string | null };
export type MasterSnapshot = { is_active?: boolean | null; vendor_code?: string; vendor_name?: string | null; merchant_name?: string | null; onboarding_date?: string | null; ee_status?: string | null };
export type ComplianceChange = { at: string; code: string; before: MasterSnapshot | null; after: MasterSnapshot | null };
export type ComplianceUpdate = { code: string; at: string };
export type WeekCompliance = 'updated' | 'missed' | 'due' | 'not-required' | 'unknown';
export type ComplianceRow = {
  code: string; name: string; merchant: string; lastUpdated: string | null;
  vendorStatus: 'active' | 'inactive';
  currentWeek: WeekCompliance; completed: number; updated: number; unknown: number;
  score: number | null; missedWeeks: number | null; streakPartial: boolean;
  overdue: boolean; weeks: { week: string; status: WeekCompliance }[];
};
export type ComplianceMonth = { month: string; currentWeek: string; generatedAt: string; coverageStart: string | null; rows: ComplianceRow[] };
export type ComplianceInput = { masters: ComplianceMaster[]; changes: ComplianceChange[]; updates: ComplianceUpdate[]; coverageStart: string | null; now: string };
export const complianceKey = (value: string) => value.trim().toLowerCase();
const dayMs = 86_400_000;
export const addComplianceDays = (day: string, n: number) => new Date(Date.parse(`${day}T00:00:00Z`) + n * dayMs).toISOString().slice(0, 10);
const instant = (day: string) => Date.parse(`${day}T00:00:00+05:30`);
/** First full Monday after observation begins. Never claim coverage of a partial week. */
export function completeHistoryStart(firstObserved: string | null): string | null {
  if (!firstObserved || !Number.isFinite(Date.parse(firstObserved))) return null;
  const monday = capacityWeekStart(new Date(firstObserved));
  return Date.parse(firstObserved) === instant(monday) ? monday : addComplianceDays(monday, 7);
}
export function complianceMonthWeeks(month: string, currentWeek: string): string[] {
  if (!/^\d{4}-(0[1-9]|1[0-2])-01$/.test(month)) throw new Error('Invalid compliance month.');
  let monday = month;
  while (new Date(`${monday}T00:00:00Z`).getUTCDay() !== 1) monday = addComplianceDays(monday, 1);
  const weeks: string[] = [];
  for (; monday.slice(0, 7) === month.slice(0, 7) && monday <= currentWeek; monday = addComplianceDays(monday, 7)) weeks.push(monday);
  return weeks;
}
/** Keep display filtering separate from historical score denominators. */
export function visibleComplianceRows(report: ComplianceMonth): ComplianceRow[] {
  const start = instant(report.currentWeek);
  const end = Math.min(Date.parse(report.generatedAt), instant(addComplianceDays(report.currentWeek, 7)) - 1);
  return report.rows.filter((row) => row.vendorStatus === 'active' ||
    (row.lastUpdated != null && Date.parse(row.lastUpdated) >= start && Date.parse(row.lastUpdated) <= end));
}
export function complianceTotals(rows: ComplianceRow[]) {
  const completed = rows.reduce((sum, r) => sum + r.completed, 0);
  const updated = rows.reduce((sum, r) => sum + r.updated, 0);
  const eligible = rows.filter((r) => r.currentWeek === 'updated' || r.currentWeek === 'due');
  return { completed, updated, score: completed ? Math.round(updated / completed * 1000) / 10 : null,
    currentEligible: eligible.length, currentUpdated: eligible.filter((r) => r.currentWeek === 'updated').length,
    currentPct: eligible.length ? Math.round(eligible.filter((r) => r.currentWeek === 'updated').length / eligible.length * 1000) / 10 : null,
    overdue: rows.filter((r) => r.overdue).length, unknown: rows.reduce((sum, r) => sum + r.unknown, 0) };
}
export function buildComplianceMonth(input: ComplianceInput, month: string): ComplianceMonth {
  const nowMs = Date.parse(input.now);
  const currentWeek = capacityWeekStart(new Date(input.now));
  const monthWeeks = complianceMonthWeeks(month, currentWeek);
  // A streak crosses month boundaries, but never crosses an unknown/inactive interval.
  const streakWeeks: string[] = [];
  if (input.coverageStart) for (let w = input.coverageStart; w < currentWeek; w = addComplianceDays(w, 7)) streakWeeks.push(w);
  const changes = new Map<string, ComplianceChange[]>();
  for (const change of input.changes) {
    const key = complianceKey(change.code);
    const list = changes.get(key) ?? []; list.push(change); changes.set(key, list);
  }
  for (const list of changes.values()) list.sort((a, b) => Date.parse(b.at) - Date.parse(a.at));
  const updates = new Map<string, Set<string>>();
  const last = new Map<string, string>();
  for (const update of input.updates) {
    const ms = Date.parse(update.at);
    if (!Number.isFinite(ms) || ms > nowMs) continue;
    const key = complianceKey(update.code);
    const weeks = updates.get(key) ?? new Set<string>();
    weeks.add(capacityWeekStart(new Date(ms))); updates.set(key, weeks);
    if (ms > Date.parse(last.get(key) ?? '1970-01-01')) last.set(key, update.at);
  }
  const rows = input.masters.map((master): ComplianceRow => {
    const key = complianceKey(master.code);
    const trail = changes.get(key) ?? [];
    const snapshotAt = (at: number): MasterSnapshot | null => {
      let state: MasterSnapshot | null = { vendor_code: master.code, ee_status: master.status, onboarding_date: master.onboarding, is_active: master.isActive };
      for (const change of trail) if (Date.parse(change.at) > at) state = change.before;
      return state;
    };
    const statusFor = (week: string): WeekCompliance => {
      const start = instant(week);
      const running = week === currentWeek;
      const end = running ? nowMs : instant(addComplianceDays(week, 7)) - 1;
      if (!running && (!input.coverageStart || week < input.coverageStart)) return 'unknown';
      const startState = snapshotAt(start), endState = snapshotAt(end);
      if (!startState || !endState) return 'not-required';
      const onboard = startState.onboarding_date ?? master.onboarding;
      if (onboard && onboard > week) return 'not-required';
      if (master.deboardedAt && Date.parse(master.deboardedAt) <= end) return 'not-required';
      const active = (state: MasterSnapshot) => state.is_active ?? null;
      const startActive = active(startState), endActive = active(endState);
      if (startActive === false || endActive === false) return 'not-required';
      if (trail.some((c) => Date.parse(c.at) > start && Date.parse(c.at) <= end && (!c.after || active(c.after) === false))) return 'not-required';
      if (startActive == null || endActive == null) return 'unknown';
      return updates.get(key)?.has(week) ? 'updated' : running ? 'due' : 'missed';
    };
    const weeks = monthWeeks.map((week) => ({ week, status: statusFor(week) }));
    const completed = weeks.filter((w) => w.week < currentWeek && (w.status === 'updated' || w.status === 'missed'));
    const done = completed.filter((w) => w.status === 'updated').length;
    let missedWeeks: number | null = null;
    let streakPartial = false;
    if (streakWeeks.length) {
      missedWeeks = 0;
      for (const w of [...streakWeeks].reverse()) {
        const status = statusFor(w);
        if (status === 'missed') missedWeeks += 1;
        else { if (status === 'unknown') { streakPartial = true; if (!missedWeeks) missedWeeks = null; } break; }
      }
      if (missedWeeks === streakWeeks.length && missedWeeks > 0) streakPartial = true;
    }
    const currentlyActive = master.isActive === true;
    return { code: master.code, name: master.name, merchant: master.merchant,
      vendorStatus: currentlyActive ? 'active' : 'inactive',
      lastUpdated: last.get(key) ?? null, currentWeek: statusFor(currentWeek), completed: completed.length, updated: done,
      unknown: weeks.filter((w) => w.week < currentWeek && w.status === 'unknown').length,
      score: completed.length ? Math.round(done / completed.length * 1000) / 10 : null,
      missedWeeks, streakPartial, overdue: statusFor(currentWeek) !== 'not-required' && statusFor(addComplianceDays(currentWeek, -7)) === 'missed', weeks };
  });
  return { month, currentWeek, generatedAt: input.now, coverageStart: input.coverageStart, rows };
}
