import 'server-only';
// Buying Plan — the ONE submit routine, shared by the user action (submitBuyingPlan) and
// the month-end auto-submit job. Callers do their own authorisation; this does the work:
//   1. the plan must hold at least one quantity;
//   2. status → submitted / pending_l2 by the routing rule (statusOnSubmit);
//   3. every non-zero line freezes its standard value from the CURRENT accepted rates,
//      so later rate changes never rewrite an in-flight / approved plan;
//   4. per-line approval set: non-zero lines not yet approved go pending, zero lines clear;
//   5. an approval-log entry.
// Runs against whatever Supabase client it is given (session-bound for a user, the
// service role for the cron), so RLS never blocks the automated path.

import { loadBuyingPlanApprovalRule } from '@/lib/buying-plan-approval.server';
import { planApprovalStatus, frozenPlanValue, pricePlanLine } from '@/lib/buying-plan-approval';
import { pageAll } from '@/lib/forms/queries-modules/_shared';
import { statusOnSubmit } from '@/lib/forms/approval';
import { loadApprovedMaterialCosts, loadApprovedStandardCosts } from '@/lib/forms/queries-modules/standard-cost';
import type { ApprovalEntity, SdStatus } from '@/lib/forms/types';
import type { AnalysisDb } from '@/lib/forms/queries-modules/buying-plan-analysis';

export type SubmitPlanResult =
  | { ok: true; status: SdStatus; qty: number; planMonth: string }
  | { ok: false; error: string; code: 'not_found' | 'wrong_state' | 'empty' | 'race' | 'db' };

export async function submitPlanCore(
  db: AnalysisDb,
  planId: number,
  actor: { email: string; label?: string },
): Promise<SubmitPlanResult> {
  const { data: plan } = await db
    .from('sd_buying_plan')
    .select('id, plan_month, status, plan_type')
    .eq('id', planId)
    .maybeSingle();
  if (!plan) return { ok: false, error: 'Plan not found.', code: 'not_found' };
  const from = plan.status as SdStatus;
  if (from !== 'draft' && from !== 'rework') {
    return { ok: false, error: 'This plan cannot be submitted from its current state.', code: 'wrong_state' };
  }

  const lines = await pageAll<Record<string,unknown>>(() => db.from('sd_buying_plan_line')
    .select('id, product_code, job_work_qty, fob_qty, efob_qty, standard_value, line_status')
    .eq('plan_id',planId).order('id'));
  const lineRows = lines as {
    id: number;
    product_code: string;
    job_work_qty: number;
    fob_qty: number;
    efob_qty: number;
    standard_value: number | null;
    line_status: SdStatus | null;
  }[];
  const qty = lineRows.reduce(
    (sum, l) => sum + Number(l.job_work_qty || 0) + Number(l.fob_qty || 0) + Number(l.efob_qty || 0),
    0,
  );
  if (qty <= 0) return { ok: false, error: 'Allocate at least one quantity before submitting.', code: 'empty' };

  const entity: ApprovalEntity = 'buying_plan';
  const approvalRule=await loadBuyingPlanApprovalRule(db);
  const isMaterial = (plan as { plan_type?: string }).plan_type === 'material';
  const fgCosts = isMaterial ? {} : await loadApprovedStandardCosts(db);
  const matCosts = isMaterial ? await loadApprovedMaterialCosts(db) : {};
  const pricedLines=lineRows.map(l=>{
    const c=isMaterial?matCosts[l.product_code]:fgCosts[l.product_code];
    const value=pricePlanLine(l,c,isMaterial);
    return {...l,standard_value:value};
  });
  const next = approvalRule ? planApprovalStatus(frozenPlanValue(pricedLines.map(l=>({...l,line_status:l.line_status==='approved'?'approved':null}))),approvalRule) : statusOnSubmit(entity,qty);

  // Guarded update: if someone else already moved it, zero rows match.
  const { data: updated, error } = await db
    .from('sd_buying_plan')
    .update({
      status: next,
      submitted_by: actor.email,
      submitted_at: new Date().toISOString(),
      rejection_notes: null,
    })
    .eq('id', planId)
    .in('status', ['draft', 'rework'])
    .select('id');
  if (error) return { ok: false, error: error.message, code: 'db' };
  if (!updated?.length) return { ok: false, error: 'Already submitted by someone else.', code: 'race' };

  // Freeze exactly the values used for routing. Unknown pricing must not retain
  // an old lower value that could let L1 approve an unpriced plan.
  for (const l of pricedLines) {
    if(Number(l.job_work_qty||0)+Number(l.fob_qty||0)+Number(l.efob_qty||0)<=0) continue;
    if(l.standard_value == null && !approvalRule) continue;
    if(l.standard_value != null && l.standard_value <= 0 && !approvalRule) continue;
    const {error:priceError}=await db.from('sd_buying_plan_line').update({standard_value:l.standard_value}).eq('id',l.id);
    if(priceError) {
      await db.from('sd_buying_plan').update({status:from}).eq('id',planId).eq('status',next);
      return {ok:false,error:priceError.message,code:'db'};
    }
  }

  // Per-line approval set: only non-zero lines need a decision; lines already approved
  // (preserved across a rework) stay approved; zero-qty lines are cleared.
  const toPending: number[] = [];
  const toClear: number[] = [];
  for (const l of lineRows) {
    const lineQty = Number(l.job_work_qty || 0) + Number(l.fob_qty || 0) + Number(l.efob_qty || 0);
    if (lineQty <= 0) toClear.push(l.id);
    else if (l.line_status !== 'approved') toPending.push(l.id);
  }
  if (toPending.length) {
    await db.from('sd_buying_plan_line').update({ line_status: next, rework_notes: null }).in('id', toPending);
  }
  if (toClear.length) {
    await db.from('sd_buying_plan_line').update({ line_status: null, rework_notes: null }).in('id', toClear);
  }

  // Audit — best effort, never rolls back the transition.
  try {
    await db.from('sd_approval_log').insert({
      entity_type: entity,
      entity_id: String(planId),
      entity_label: `Buying plan ${String(plan.plan_month).slice(0, 7)}`,
      from_status: from,
      to_status: next,
      actor_email: actor.email,
      notes: actor.label ?? null,
    });
  } catch (e) {
    console.error('sd_approval_log insert failed', e);
  }

  return { ok: true, status: next, qty, planMonth: String(plan.plan_month) };
}
