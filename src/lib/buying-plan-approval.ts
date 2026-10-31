import { canApprove } from './forms/approval';
import type { SdRole, SdStatus } from './forms/types';
export type BuyingPlanApprovalRule = { l1_email: string; l2_email: string; max_value: number; updated_by?: string | null; updated_at?: string | null };
export function planApprovalStatus(value: number | null, rule: BuyingPlanApprovalRule): SdStatus {
  return value != null && Number.isFinite(value) && value >= 0 && Math.round(value * 100) <= Math.round(rule.max_value * 100) ? 'submitted' : 'pending_l2';
}
export function canDecideBuyingPlan(user: { email: string; role: SdRole }, status: SdStatus, rule: BuyingPlanApprovalRule | null, value: number | null): boolean {
  if (user.role === 'viewer' || !['submitted','pending_l2'].includes(status)) return false;
  if (!rule) return canApprove(user.role, status);
  const email = user.email.trim().toLowerCase();
  if (email === rule.l2_email.toLowerCase()) return true;
  return email === rule.l1_email.toLowerCase() && planApprovalStatus(value, rule) === 'submitted';
}
export function frozenPlanValue(lines: { job_work_qty?: unknown; fob_qty?: unknown; efob_qty?: unknown; standard_value?: unknown; line_status?: unknown }[]): number | null {
  let cents=0;
  for (const l of lines) {
    if (l.line_status === 'rejected' || Number(l.job_work_qty||0)+Number(l.fob_qty||0)+Number(l.efob_qty||0)<=0) continue;
    if (l.standard_value == null || !Number.isFinite(Number(l.standard_value)) || Number(l.standard_value)<0) return null;
    cents+=Math.round(Number(l.standard_value)*100);
  }
  return cents/100;
}

/** Missing accepted rates must not make a plan look cheaper than it is. */
export function pricePlanLine(line: {job_work_qty?:unknown;fob_qty?:unknown;efob_qty?:unknown}, cost: {job:number;fob:number;efob?:number}|undefined, material=false): number|null {
  const lanes:[[unknown,number|undefined],[unknown,number|undefined],[unknown,number|undefined]]=[[line.job_work_qty,cost?.job],[line.fob_qty,cost?.fob],[material?0:line.efob_qty,cost?.efob]];
  let value=0;
  for(const [raw,rate] of lanes) { const qty=Number(raw||0); if(qty>0) { if(rate==null||!Number.isFinite(rate)||rate<=0) return null; value+=qty*rate; } }
  return Number.isFinite(value)?Math.round(value*100)/100:null;
}
