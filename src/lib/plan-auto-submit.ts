import 'server-only';
// Buying Plan — month-end AUTO-SUBMIT (spec item 5): on the last day of month M, the
// draft finished-goods plan for month M+1 is submitted for approval automatically, so
// the approval clock (deadline: the 7th of M+1, Rules Master) starts on time whether or
// not the team pressed Submit. Only a DRAFT plan is touched: a plan already submitted,
// in rework or approved is left alone. An empty/missing plan cannot be submitted — that
// is reported to ops Slack because it means a submission-side breach is coming.

import { addMonths, monthLabel, monthStart } from '@/lib/forms/approval';
import { createAdminClient, hasSupabaseAdminEnv } from '@/lib/supabase/admin';
import { submitPlanCore } from '@/lib/plan-submit';
import { notifyPlanAutoSubmitSlack } from '@/lib/slack';
import type { AnalysisDb } from '@/lib/forms/queries-modules/buying-plan-analysis';

export const AUTO_SUBMIT_ACTOR = 'auto-submit@month-end';

/** True when the IST calendar day after `now` is the 1st of a month. */
export function isLastDayOfMonthIst(now = new Date()): boolean {
  const ist = new Date(now.getTime() + 5.5 * 3600_000);
  const tomorrow = new Date(ist.getTime() + 86_400_000);
  return tomorrow.getUTCDate() === 1;
}

export type AutoSubmitResult = {
  planMonth: string;
  outcome: 'submitted' | 'skipped_state' | 'no_plan' | 'empty' | 'error';
  detail: string;
};

/**
 * Submit next month's FG plan. `targetMonth` defaults to the month after the current IST
 * month (i.e. when run on 30 Sept, the October plan).
 */
export async function autoSubmitNextMonthPlan(targetMonth?: string): Promise<AutoSubmitResult> {
  const planMonth = targetMonth && /^\d{4}-\d{2}-01$/.test(targetMonth) ? targetMonth : addMonths(monthStart(), 1);
  const label = monthLabel(planMonth);
  if (!hasSupabaseAdminEnv()) {
    return { planMonth, outcome: 'error', detail: 'Service-role key not configured.' };
  }
  const admin = createAdminClient() as unknown as AnalysisDb;

  const { data: plan } = await admin
    .from('sd_buying_plan')
    .select('id, status')
    .eq('plan_month', planMonth)
    .eq('plan_type', 'fg')
    .maybeSingle();

  if (!plan) {
    const detail = `No ${label} finished-goods plan exists — nothing to submit. The team must create and fill it; the approval deadline still stands.`;
    await notifyPlanAutoSubmitSlack({ monthLabel: label, outcome: 'no_plan', detail });
    return { planMonth, outcome: 'no_plan', detail };
  }
  if (plan.status !== 'draft') {
    return { planMonth, outcome: 'skipped_state', detail: `${label} plan is already ${plan.status} — left as is.` };
  }

  const res = await submitPlanCore(admin, Number(plan.id), { email: AUTO_SUBMIT_ACTOR, label: 'Auto-submitted at month-end' });
  if (!res.ok) {
    if (res.code === 'empty') {
      const detail = `${label} plan is still empty (no quantities) — it could not be auto-submitted. Fill and submit it before the deadline.`;
      await notifyPlanAutoSubmitSlack({ monthLabel: label, outcome: 'empty', detail });
      return { planMonth, outcome: 'empty', detail };
    }
    return { planMonth, outcome: 'error', detail: res.error };
  }

  const detail = `${label} plan auto-submitted for approval (${res.qty.toLocaleString('en-IN')} pcs, routed to ${res.status === 'pending_l2' ? 'admin' : 'team'} approval).`;
  await notifyPlanAutoSubmitSlack({ monthLabel: label, outcome: 'submitted', detail, planMonth });
  return { planMonth, outcome: 'submitted', detail };
}
