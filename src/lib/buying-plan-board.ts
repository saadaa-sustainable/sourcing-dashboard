import { monthStart } from './forms/approval';

/** The month-freeze rule remains authoritative for approved past months. */
export function buyingPlanMonthColumn(
  cards: { status: string; metrics?: { hasPlan: boolean } }[],
): string {
  // A missing track has no draft to approve and cannot demote an existing plan.
  const existing = cards.filter((card) => card.metrics?.hasPlan);
  const statuses = (existing.length ? existing : cards).map((card) => card.status);
  if (statuses.includes('pending')) return 'pending';
  if (statuses.includes('draft')) return 'draft';
  return statuses.length && statuses.every((status) => status === 'closed') ? 'closed' : 'live';
}

/** An absent past track is closed for display, without inventing plan quantities. */
export function unstartedBuyingPlanTrack(month: string, now = new Date()) {
  return month < monthStart(now)
    ? { status: 'closed', label: 'Auto-Approved via Workflow' }
    : { status: 'draft', label: 'Not started' };
}
