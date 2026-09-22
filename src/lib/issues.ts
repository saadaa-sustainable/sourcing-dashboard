/**
 * Issue tracker — vocabulary, types and the pure arithmetic. Plain module (no server or
 * client directive) so the page, the actions and the loaders all share it. Unit-tested.
 */

export type IssueCategory =
  | 'po' | 'tna' | 'vendor' | 'product' | 'inventory' | 'plan' | 'cost' | 'data' | 'other';
export type IssueStatus = 'open' | 'in_progress' | 'resolved' | 'dismissed';
export type IssueSeverity = 'low' | 'medium' | 'high' | 'blocker';
export type IssueSource = 'manual' | 'auto';

export const ISSUE_CATEGORIES: { key: IssueCategory; label: string }[] = [
  { key: 'po', label: 'Purchase orders' },
  { key: 'tna', label: 'TNA / production timeline' },
  { key: 'vendor', label: 'Vendors' },
  { key: 'product', label: 'Products / master data' },
  { key: 'inventory', label: 'Stock / out of stock' },
  { key: 'plan', label: 'Buying plan' },
  { key: 'cost', label: 'Standard cost / rates' },
  { key: 'data', label: 'Data feeds / sync' },
  { key: 'other', label: 'Other' },
];
export const ISSUE_CATEGORY_LABEL = Object.fromEntries(
  ISSUE_CATEGORIES.map((c) => [c.key, c.label]),
) as Record<IssueCategory, string>;

export const ISSUE_STATUS_LABEL: Record<IssueStatus, string> = {
  open: 'Open',
  in_progress: 'In progress',
  resolved: 'Resolved',
  dismissed: 'Dismissed',
};
export const ISSUE_SEVERITY_LABEL: Record<IssueSeverity, string> = {
  low: 'Low',
  medium: 'Medium',
  high: 'High',
  blocker: 'Blocker',
};

export const isIssueOpen = (s: IssueStatus) => s === 'open' || s === 'in_progress';

export type IssueRow = {
  id: number;
  category: IssueCategory;
  title: string;
  detail: string | null;
  related_ref: string | null;
  page_path: string | null;
  source: IssueSource;
  auto_key: string | null;
  severity: IssueSeverity;
  status: IssueStatus;
  raised_by: string | null;
  raised_at: string;
  assignee: string | null;
  assigned_via: 'manual' | 'route' | null;
  assigned_at: string | null;
  resolved_at: string | null;
  resolved_by: string | null;
  resolution: string | null;
  updated_at: string;
  messageCount: number;
};

export type IssueMessage = {
  id: number;
  issue_id: number;
  author_email: string | null;
  body: string;
  created_at: string;
};

export type IssueRoute = {
  category: IssueCategory;
  label: string;
  assignee: string | null;
  updated_by: string | null;
  updated_at: string;
};

const DAY = 86_400_000;

/** Whole days from raise to resolve — or to now while still open. */
export function daysOpen(raisedAt: string, resolvedAt: string | null, now = Date.now()): number {
  const end = resolvedAt ? Date.parse(resolvedAt) : now;
  return Math.max(0, Math.floor((end - Date.parse(raisedAt)) / DAY));
}

/** Who a category routes to; null when the route is unset. */
export function routeFor(category: IssueCategory, routes: IssueRoute[]): string | null {
  const r = routes.find((x) => x.category === category);
  return r?.assignee?.trim() || null;
}

export type IssueStats = {
  open: number;
  inProgress: number;
  unassigned: number;
  autoOpen: number;
  oldestOpenDays: number | null;
  /** Resolved in the last 30 days, and their average days from raise to resolve. */
  resolvedLast30: number;
  avgDaysToResolve30: number | null;
  byCategory: { category: IssueCategory; open: number }[];
  byAssignee: { assignee: string; open: number }[];
};

export function computeIssueStats(rows: IssueRow[], now = Date.now()): IssueStats {
  const live = rows.filter((r) => isIssueOpen(r.status));
  const since = now - 30 * DAY;
  const resolved30 = rows.filter((r) => r.status === 'resolved' && r.resolved_at && Date.parse(r.resolved_at) >= since);
  const cat = new Map<IssueCategory, number>();
  const who = new Map<string, number>();
  let oldest: number | null = null;
  for (const r of live) {
    cat.set(r.category, (cat.get(r.category) ?? 0) + 1);
    const a = r.assignee?.trim() || 'Unassigned';
    who.set(a, (who.get(a) ?? 0) + 1);
    const d = daysOpen(r.raised_at, null, now);
    if (oldest == null || d > oldest) oldest = d;
  }
  const days = resolved30.map((r) => daysOpen(r.raised_at, r.resolved_at, now));
  return {
    open: live.length,
    inProgress: live.filter((r) => r.status === 'in_progress').length,
    unassigned: live.filter((r) => !r.assignee?.trim()).length,
    autoOpen: live.filter((r) => r.source === 'auto').length,
    oldestOpenDays: oldest,
    resolvedLast30: resolved30.length,
    avgDaysToResolve30: days.length ? Math.round((days.reduce((s, d) => s + d, 0) / days.length) * 10) / 10 : null,
    byCategory: [...cat.entries()].map(([category, open]) => ({ category, open })).sort((a, b) => b.open - a.open),
    byAssignee: [...who.entries()].map(([assignee, open]) => ({ assignee, open })).sort((a, b) => b.open - a.open),
  };
}

/* ------------------------------------------------------------------ */
/* Auto-raised issues                                                  */
/* ------------------------------------------------------------------ */

/** One thing a dashboard check found wrong, keyed so it is raised once and closed when gone. */
export type AutoDetection = {
  key: string;
  category: IssueCategory;
  title: string;
  detail: string;
  related_ref: string | null;
  page_path: string | null;
  severity: IssueSeverity;
};

/**
 * What to raise and what to close, given what is detected now and which auto issues are
 * live. A key detected and live = nothing to do; detected and not live = raise; live and
 * no longer detected = close (the condition went away, whoever fixed it).
 */
export function diffAutoIssues(
  detected: AutoDetection[],
  liveKeys: string[],
): { toRaise: AutoDetection[]; toClose: string[] } {
  const live = new Set(liveKeys);
  const now = new Set(detected.map((d) => d.key));
  return {
    toRaise: detected.filter((d) => !live.has(d.key)),
    toClose: liveKeys.filter((k) => !now.has(k)),
  };
}
