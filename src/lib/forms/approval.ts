import type { ApprovalEntity, SdRole, SdStatus } from './types';

/**
 * The approval rules live here and nowhere else.
 *
 * Deliberately NOT surfaced in any UI copy — the thresholds are internal.
 * Every form imports from this file so a rule change is a one-line edit.
 */

/** Quantity above which an approval escalates past L1. */
export const L2_THRESHOLD_QTY = 5_000;

/**
 * Entities that always escalate regardless of quantity.
 * NPD product POs bypass the threshold entirely.
 */
const ALWAYS_L2: ApprovalEntity[] = ['discontinue'];

export function routeApproval(entity: ApprovalEntity, quantity = 0): SdRole {
  if (ALWAYS_L2.includes(entity)) return 'approver_l2';
  return quantity > L2_THRESHOLD_QTY ? 'approver_l2' : 'approver_l1';
}

/** Status reached when a draft is submitted, given who has to sign it off. */
export function statusOnSubmit(entity: ApprovalEntity, quantity = 0): SdStatus {
  return routeApproval(entity, quantity) === 'approver_l2'
    ? 'pending_l2'
    : 'submitted';
}

/* ------------------------------------------------------------------ */
/* Permissions                                                         */
/* ------------------------------------------------------------------ */

const RANK: Record<SdRole, number> = {
  viewer: 0,
  supply_chain: 1,
  approver_l1: 2,
  approver_l2: 3,
  admin: 4,
};

export function canEdit(role: SdRole, status: SdStatus) {
  if (status === 'approved') return false;
  return RANK[role] >= RANK.supply_chain;
}

export function canSubmit(role: SdRole, status: SdStatus) {
  return status === 'draft' && RANK[role] >= RANK.supply_chain;
}

export function canApprove(role: SdRole, status: SdStatus) {
  if (status === 'submitted') return RANK[role] >= RANK.approver_l1;
  if (status === 'pending_l2') return RANK[role] >= RANK.approver_l2;
  return false;
}

/* ------------------------------------------------------------------ */
/* Display                                                             */
/* ------------------------------------------------------------------ */

export const STATUS_LABEL: Record<SdStatus, string> = {
  draft: 'Draft',
  submitted: 'Awaiting L1 approval',
  pending_l2: 'Awaiting L2 approval',
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
  viewer: 'Viewer',
  supply_chain: 'Supply chain',
  approver_l1: 'Approver — L1',
  approver_l2: 'Approver — L2',
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
