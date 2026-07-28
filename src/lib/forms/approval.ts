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
const ALWAYS_ADMIN: ApprovalEntity[] = ['discontinue', 'standard_cost'];

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
  return status === 'draft' && RANK[role] >= RANK.team;
}

export function canApprove(role: SdRole, status: SdStatus) {
  // Routine items (status 'submitted') can be signed off by the team; anything
  // escalated to 'pending_l2' needs an admin (founder).
  if (status === 'submitted') return RANK[role] >= RANK.team;
  if (status === 'pending_l2') return RANK[role] >= RANK.admin;
  return false;
}

/* ------------------------------------------------------------------ */
/* Display                                                             */
/* ------------------------------------------------------------------ */

export const STATUS_LABEL: Record<SdStatus, string> = {
  draft: 'Draft',
  submitted: 'Awaiting team approval',
  pending_l2: 'Awaiting admin approval',
  approved: 'Approved',
  rejected: 'Rejected',
};

/** Maps onto the existing .tone-* classes in globals.css. */
export const STATUS_TONE: Record<SdStatus, string> = {
  draft: 'purple',
  submitted: 'orange',
  pending_l2: 'orange',
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

/** Buying plan for month M opens 7 days before M starts. */
export function isPlanWindowOpen(planMonth: string, today = new Date()): boolean {
  const [y, m] = planMonth.split('-').map(Number);
  const opens = new Date(Date.UTC(y, m - 1, 1) - 7 * 86_400_000);
  return today.getTime() >= opens.getTime();
}
