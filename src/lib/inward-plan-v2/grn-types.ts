import type { Plan, PlanLine } from './types';
export type SystemGrn = {
  product_code?: string | null;
  grn_detail_id: string; grn_id: string | null; po_detail_id: string; po_number: string;
  po_ref_num: string | null; sku: string; size: string | null; received_on: string;
  received_qty: number; synced_at: string;
};
export type DelayReport = {
  id: string; plan_id: string; line_id: string; reported_qty: number; received_on: string | null;
  delay_reason: string | null; follow_up_on: string | null; remarks: string | null;
  status: string; updated_at: string;
};
export type Reconciliation = {
  id: string; tracker_id: string; plan_id: string; line_id: string; grn_detail_id: string;
  quantity: number; grn_id: string | null; po_detail_id: string; po_number: string; sku: string; size: string | null;
  system_received_on: string; system_qty: number; system_synced_at: string;
  created_by: string; created_at: string; reversed_at: string | null; reversed_by: string | null; reversal_reason: string | null;
};
export type GrnData = { plans: Plan[]; lines: PlanLine[]; reports: DelayReport[]; reconciliations: Reconciliation[]; receipts: SystemGrn[] };
