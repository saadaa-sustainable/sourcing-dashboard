import { inrShort, num } from '@/lib/month-board';
import type { MonthBoardData, MonthBoardColumn } from '@/lib/month-board';
import { deadlineLabel } from './validation';
import { STATUS_LABEL } from './types';
import type { Plan } from './types';
export type BoardLine = { plan_id: string; product_code: string; inward_qty: number; cost_per_piece: number | null };
export function buildPlanBoard(plans: Plan[], lines: BoardLine[]): MonthBoardData {
  const columns: MonthBoardColumn[] = [
    { key: 'draft', label: 'Draft', tone: 'draft', hint: 'Being filled - not submitted yet' },
    { key: 'pending_l2', label: 'Approval Pending', tone: 'pending', hint: 'Submitted - waiting for the admin' },
    { key: 'approved', label: 'Approved', tone: 'live', hint: 'Approved inward receipt schedules' },
    ...(['rework', 'rejected'] as const).filter(status => plans.some(plan => plan.status === status)).map(status => ({
      key: status, label: STATUS_LABEL[status], tone: 'back' as const,
      hint: status === 'rework' ? 'Returned for changes and resubmission' : 'Rejected or discarded plans',
    })),
  ];
  const byPlan = new Map<string, BoardLine[]>();
  for (const line of lines) { const rows = byPlan.get(line.plan_id) ?? []; rows.push(line); byPlan.set(line.plan_id, rows); }
  return {
    columns, listActions: 'all', totals: [], unit: 'plans', noun: 'plan', cardClick: 'open',
    listColumns: [{ label: 'Period' }, { label: 'Quantity', num: true }, { label: 'Submission deadline' }, { label: 'Owner' }],
    cards: plans.map(plan => {
      const rows = byPlan.get(plan.id) ?? [];
      const quantity = rows.reduce((sum, row) => sum + Number(row.inward_qty), 0);
      const products = new Set(rows.map(row => row.product_code)).size;
      const value = rows.length && rows.every(row => row.cost_per_piece != null)
        ? rows.reduce((sum, row) => sum + Number(row.inward_qty) * Number(row.cost_per_piece), 0) : null;
      const cadence = plan.period_kind === 'weekly' ? 'Weekly' : 'Monthly';
      return {
        searchText: [plan.period_start,plan.period_end,plan.created_by,new Date(plan.period_start + 'T00:00:00Z').toLocaleDateString('en-IN',{month:'long',year:'numeric',timeZone:'UTC'})].join(' '),
        id: plan.id, month: plan.period_start, label: plan.title, track: cadence, status: plan.status,
        big: { value: inrShort(value), label: value == null ? 'Plan value unavailable' : 'Planned receipt value' },
        sub: plan.period_start + ' - ' + plan.period_end,
        trackProgress: [{ label: 'Planned receipts', left: num(quantity) + ' pieces / ' + products + ' products', right: rows.length + ' lines', pct: null }],
        facts: ['Submit by ' + deadlineLabel(plan.submission_deadline), 'Owner: ' + plan.created_by, 'Revision ' + plan.revision],
        warn: plan.decision_notes ? { text: plan.decision_notes, tone: 'back' as const } : undefined,
        actions: [
          { label: 'Open plan', href: '/inward-plan-v2?id=' + plan.id, primary: true },
          { label: 'Analytics', href: '/inward-plan-v2/analytics?cadence=' + plan.period_kind + '&start=' + plan.period_start },
          { label: 'GRN Delay Tracker', href: '/inward-plan-v2/grn-delay-tracker?cadence=' + plan.period_kind },
        ],
        list: [cadence + ' / ' + plan.period_start + ' - ' + plan.period_end, num(quantity), deadlineLabel(plan.submission_deadline), plan.created_by],
      };
    }),
  };
}
