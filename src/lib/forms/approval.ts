import type { ApprovalEntity, SdRole, SdStatus } from './types';

/**
 * The approval rules live here and nowhere else.
 *
 * Deliberately NOT surfaced in any UI copy — the thresholds are internal.
 * Every form imports from this file so a rule change is a one-line edit.
 */

/** Quantity above which an approval escalates from team to admin. */
export const ADMIN_THRESHOLD_QTY = 5_000;

/** Entities that always need admin (founder) approval, whatever the quantity. */
const ALWAYS_ADMIN: ApprovalEntity[] = ['discontinue', 'standard_cost', 'material_cost', 'vendor_deboarding', 'po_delete'];

/** PO categories that always need 2-level (admin) approval, whatever the qty. */
const PO_ALWAYS_ADMIN = ['npd', 'mat'];

/**
 * Who has to approve: the team can sign off routine items, admin the rest.
 *
 * For a PO Approval, pass its `category` — NPD and MAT are always 2-level
 * (admin); only FG follows the quantity threshold (≤5000 → team, >5000 → admin).
 */
export function routeApproval(
  entity: ApprovalEntity,
  quantity = 0,
  category?: string | null,
): SdRole {
  if (ALWAYS_ADMIN.includes(entity)) return 'admin';
  if (entity === 'po_approval' && PO_ALWAYS_ADMIN.includes(String(category).toLowerCase())) {
    return 'admin';
  }
  return quantity > ADMIN_THRESHOLD_QTY ? 'admin' : 'team';
}

/** Status reached when a draft is submitted, given who has to sign it off. */
export function statusOnSubmit(
  entity: ApprovalEntity,
  quantity = 0,
  category?: string | null,
): SdStatus {
  return routeApproval(entity, quantity, category) === 'admin'
    ? 'pending_l2'
    : 'submitted';
}

/* ------------------------------------------------------------------ */
/* Permissions                                                         */
/* ------------------------------------------------------------------ */

const RANK: Record<SdRole, number> = {
  viewer: 0,
  team: 1,
  admin: 2,
};

export function canEdit(role: SdRole, status: SdStatus) {
  if (status === 'approved') return false;
  return RANK[role] >= RANK.team;
}

export function canSubmit(role: SdRole, status: SdStatus) {
  // A reworked record can be fixed and re-submitted, same as a draft.
  return (status === 'draft' || status === 'rework') && RANK[role] >= RANK.team;
}

export function canApprove(role: SdRole, status: SdStatus) {
  // Routine items (status 'submitted') can be signed off by the team; anything
  // escalated to 'pending_l2' needs an admin (founder).
  if (status === 'submitted') return RANK[role] >= RANK.team;
  if (status === 'pending_l2') return RANK[role] >= RANK.admin;
  return false;
}

/** Sending back for Rework/Reassign is an approver action — same gate as approve. */
export function canRework(role: SdRole, status: SdStatus) {
  return canApprove(role, status);
}

/* ---- Spec 7.5: the escalation matrix ------------------------------ */

export type ApprovalLevel = 'l1' | 'l2' | 'l3';

/** Who sits at each level, in order: [primary, fallback, fallback…]. */
export type ApprovalMatrix = Record<ApprovalLevel, string[]>;

export const EMPTY_MATRIX: ApprovalMatrix = { l1: [], l2: [], l3: [] };

export const LEVEL_LABEL: Record<ApprovalLevel, string> = {
  l1: 'L1',
  l2: 'L2',
  l3: 'L3 (final)',
};

/** Which level an item is waiting at. Cost negotiation and the rest have no level. */
export function levelForStatus(status: SdStatus): ApprovalLevel | null {
  if (status === 'submitted') return 'l1';
  if (status === 'pending_l2') return 'l2';
  return null;
}

const LADDER: ApprovalLevel[] = ['l1', 'l2', 'l3'];
const sameEmail = (a: string | null | undefined, b: string | null | undefined) =>
  Boolean(a && b && a.trim().toLowerCase() === b.trim().toLowerCase());

/** The named approvers for an item's level — empty when the matrix has not been filled in. */
export function approversFor(status: SdStatus, matrix: ApprovalMatrix): string[] {
  const level = levelForStatus(status);
  return level ? matrix[level] : [];
}

/**
 * Has an item waited long enough at its level for the level above to step in?
 * That is what makes this a matrix rather than a list: the work does not stop because
 * the person whose turn it is is away.
 */
export function isEscalated(
  waitingSince: string | null | undefined,
  escalationDays: number,
  today = new Date(),
): boolean {
  if (!waitingSince || !Number.isFinite(escalationDays) || escalationDays <= 0) return false;
  const since = Date.parse(waitingSince);
  if (Number.isNaN(since)) return false;
  return (today.getTime() - since) / 86_400_000 >= escalationDays;
}

/**
 * May this person decide this item?
 *
 * The matrix is authoritative where it is filled in, and silent where it is not: a level
 * with nobody named falls back to the role ladder, so this can be adopted one level at a
 * time. L3 is the final authority and can always decide; an admin can too, because that is
 * what the role means here. Once an item has escalated, everyone above its level can act.
 */
export function canDecide(
  user: { role: SdRole; email?: string | null },
  status: SdStatus,
  matrix: ApprovalMatrix = EMPTY_MATRIX,
  escalated = false,
): boolean {
  const level = levelForStatus(status);
  if (!level) return canApprove(user.role, status);
  if (matrix.l3.some((e) => sameEmail(e, user.email))) return true;
  if (user.role === 'admin') return true;

  const named = matrix[level];
  if (!named.length) return canApprove(user.role, status); // level not configured yet
  if (named.some((e) => sameEmail(e, user.email))) return true;

  if (escalated) {
    // Everyone above the stuck level can step in — that is the point of escalating.
    const above = LADDER.slice(LADDER.indexOf(level) + 1);
    if (above.some((l) => matrix[l].some((e) => sameEmail(e, user.email)))) return true;
  }
  return false;
}

/**
 * Who may delete a raised PO request: the person who raised it, or an admin.
 *
 * A request can be pulled back at any point BEFORE it is approved — including while
 * it sits in the approval queue, which is the common case (raised in error, wrong
 * vendor, the need went away). Once approved it is a commitment: undoing that is a
 * cancellation with its own consequences, not a delete.
 *
 * Deleting never removes the row; it is marked with who, when and why (the reason is
 * mandatory), so the record survives for admin to look at.
 */
export function canDeletePo(
  role: SdRole,
  status: SdStatus,
  createdBy: string | null | undefined,
  viewerEmail: string | null | undefined,
): boolean {
  if (status === 'approved') return false;
  if (RANK[role] < RANK.team) return false; // a viewer deletes nothing
  if (role === 'admin') return true;
  const mine = (createdBy ?? '').trim().toLowerCase();
  const me = (viewerEmail ?? '').trim().toLowerCase();
  return Boolean(mine && me && mine === me);
}

/* ------------------------------------------------------------------ */
/* Display                                                             */
/* ------------------------------------------------------------------ */

export const STATUS_LABEL: Record<SdStatus, string> = {
  draft: 'Draft',
  submitted: 'Approval Pending',
  pending_l2: 'Approval Pending',
  rework: 'Rework-and-Reassign',
  approved: 'Approved',
  rejected: 'Rejected',
};

/** Maps onto the existing .tone-* classes in globals.css. */
export const STATUS_TONE: Record<SdStatus, string> = {
  draft: 'purple',
  submitted: 'orange',
  pending_l2: 'orange',
  rework: 'orange',
  approved: 'teal',
  rejected: 'red',
};

export const ROLE_LABEL: Record<SdRole, string> = {
  viewer: 'Viewer (read-only)',
  team: 'Team',
  admin: 'Admin',
};

/* ------------------------------------------------------------------ */
/* Dates                                                               */
/* ------------------------------------------------------------------ */

/** First day of the month, in IST, as an ISO date string. */
export function monthStart(date = new Date()): string {
  const ist = new Date(date.getTime() + 5.5 * 3600_000);
  return `${ist.getUTCFullYear()}-${String(ist.getUTCMonth() + 1).padStart(2, '0')}-01`;
}

export function addMonths(isoMonth: string, delta: number): string {
  const [y, m] = isoMonth.split('-').map(Number);
  const d = new Date(Date.UTC(y, m - 1 + delta, 1));
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}-01`;
}

export function monthLabel(isoMonth: string): string {
  const [y, m] = isoMonth.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, 1)).toLocaleDateString('en-IN', {
    month: 'long',
    year: 'numeric',
    timeZone: 'UTC',
  });
}

/**
 * Monday of the current capacity week, IST.
 * Capacity is submitted before Monday 14:00 IST; the PPM meeting is at 16:00.
 */
export function weekStart(date = new Date()): string {
  const ist = new Date(date.getTime() + 5.5 * 3600_000);
  const dow = ist.getUTCDay(); // 0 = Sunday
  const back = dow === 0 ? 6 : dow - 1;
  const monday = new Date(ist.getTime() - back * 86_400_000);
  return monday.toISOString().slice(0, 10);
}

export function weekLabel(isoDate: string): string {
  const d = new Date(`${isoDate}T00:00:00Z`);
  return `Week of ${d.toLocaleDateString('en-IN', {
    day: 'numeric',
    month: 'short',
    year: 'numeric',
    timeZone: 'UTC',
  })}`;
}

/**
 * The vendor-capacity week runs Saturday to Friday: a vendor's figures are submitted once
 * a week and lock on submission; the next week opens automatically on Saturday. Returns
 * the Saturday (IST) that started the current capacity week, as an ISO date.
 */
export function capacityWeekStart(date = new Date()): string {
  const ist = new Date(date.getTime() + 5.5 * 3600_000);
  const dow = ist.getUTCDay(); // 0 = Sunday … 6 = Saturday
  const back = (dow + 1) % 7; // days since the last Saturday
  const saturday = new Date(ist.getTime() - back * 86_400_000);
  return saturday.toISOString().slice(0, 10);
}

/** The Saturday the next capacity week opens on, as an ISO date. */
export function capacityWeekNext(date = new Date()): string {
  const start = new Date(`${capacityWeekStart(date)}T00:00:00Z`);
  return new Date(start.getTime() + 7 * 86_400_000).toISOString().slice(0, 10);
}

/** Was this submission made inside the current capacity week (so the row is locked)? */
export function capacityLocked(submittedAt: string | null | undefined, date = new Date()): boolean {
  if (!submittedAt) return false;
  const weekStartUtc = Date.parse(`${capacityWeekStart(date)}T00:00:00Z`) - 5.5 * 3600_000;
  return Date.parse(submittedAt) >= weekStartUtc;
}

/** Buying plan for month M opens 7 days before M starts. */
export function isPlanWindowOpen(planMonth: string, today = new Date()): boolean {
  const [y, m] = planMonth.split('-').map(Number);
  const opens = new Date(Date.UTC(y, m - 1, 1) - 7 * 86_400_000);
  return today.getTime() >= opens.getTime();
}

/* ------------------------------------------------------------------ */
/* Month-end freeze + approval deadline (spec item 5)                  */
/* ------------------------------------------------------------------ */

/**
 * Month-end FREEZE: the plan for month M is frozen from 00:00 IST on the 1st of M+1.
 * A pure date rule — nothing is stored and no scheduler is needed. Frozen plans take
 * no direct edits and no PO may be linked to them; the only way to change one is an
 * amendment routed through approval (rework).
 */
export function isPlanFrozen(planMonth: string, today = new Date()): boolean {
  return monthStart(today) > planMonth;
}

/** The instant (UTC) the approval deadline passes: `day` of the plan month, 23:59:59 IST. */
export function planApprovalDeadline(planMonth: string, day = 7): Date {
  const [y, m] = planMonth.split('-').map(Number);
  // 23:59:59 IST = 18:29:59 UTC the same calendar day.
  return new Date(Date.UTC(y, m - 1, day, 18, 29, 59));
}

export type PlanCompliance = {
  deadline: string; // ISO
  deadlineDay: number;
  /** on_time = approved by the deadline; breach_* = approved (or still open) after it;
   *  pending = deadline not yet reached and not yet approved. */
  status: 'on_time' | 'pending' | 'breach_submission' | 'breach_approval';
  daysLate: number; // whole days past the deadline (0 when on time / pending)
};

/**
 * Did an admin ACT on the plan (approve / reject / send for rework) by the deadline? If
 * not, WHO was late: the submission side (not even submitted by the deadline) or the
 * approval side (submitted in time but no decision by then). `action_at` is the first
 * admin decision (from the approval log); `approved_at` is the fallback. A plan with no
 * decision past the deadline is a live breach that grows until someone acts.
 */
export function planComplianceStatus(
  plan: { submitted_at: string | null; approved_at: string | null; action_at?: string | null } | null,
  planMonth: string,
  deadlineDay = 7,
  today = new Date(),
): PlanCompliance {
  const deadline = planApprovalDeadline(planMonth, deadlineDay);
  const dl = deadline.getTime();
  const submitted = plan?.submitted_at ? Date.parse(plan.submitted_at) : null;
  const firstAction = plan?.action_at ? Date.parse(plan.action_at) : plan?.approved_at ? Date.parse(plan.approved_at) : null;
  const approved = firstAction;
  const daysAfter = (t: number) => Math.max(0, Math.floor((t - dl) / 86_400_000));
  const base = { deadline: deadline.toISOString(), deadlineDay };
  if (approved != null) {
    if (approved <= dl) return { ...base, status: 'on_time', daysLate: 0 };
    return {
      ...base,
      status: submitted != null && submitted <= dl ? 'breach_approval' : 'breach_submission',
      daysLate: daysAfter(approved),
    };
  }
  if (today.getTime() <= dl) return { ...base, status: 'pending', daysLate: 0 };
  return {
    ...base,
    status: submitted != null && submitted <= dl ? 'breach_approval' : 'breach_submission',
    daysLate: daysAfter(today.getTime()),
  };
}
