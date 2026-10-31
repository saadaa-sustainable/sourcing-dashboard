import 'server-only';
import { client, pageAll } from './forms/queries-modules/_shared';
import { canDecideBuyingPlan, frozenPlanValue, type BuyingPlanApprovalRule } from './buying-plan-approval';
import type { SdRole, SdStatus } from './forms/types';
export async function loadBuyingPlanApprovalRule(database?: unknown): Promise<BuyingPlanApprovalRule | null> {
  const db = (database ?? await client()) as Awaited<ReturnType<typeof client>>;
  const {data,error}=await db.from('sd_buying_plan_approval_rule').select('l1_email,l2_email,max_value,updated_by,updated_at').eq('id',1).maybeSingle();
  if(error) { if(['42P01','PGRST205'].includes(error.code)) return null; throw new Error(error.message); }
  return data ? {...data,max_value:Number(data.max_value)} as BuyingPlanApprovalRule : null;
}
export async function buyingPlanDecisionAllowed(user: { email: string; role: SdRole }, planId: number | string, status: SdStatus, database?: unknown) {
  const db=(database ?? await client()) as Awaited<ReturnType<typeof client>>;
  const rule=await loadBuyingPlanApprovalRule(db);
  if(!rule) return canDecideBuyingPlan(user,status,null,null);
  const lines=await pageAll<{job_work_qty:number;fob_qty:number;efob_qty:number;standard_value:number|null;line_status:string|null}>(()=>db.from('sd_buying_plan_line').select('job_work_qty,fob_qty,efob_qty,standard_value,line_status').eq('plan_id',planId).order('id'));
  return canDecideBuyingPlan(user,status,rule,frozenPlanValue(lines));
}
