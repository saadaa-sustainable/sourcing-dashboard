export type PlanStatus = 'draft' | 'pending_l2' | 'approved' | 'rework' | 'rejected';
export type PeriodKind = 'weekly' | 'monthly';
export type Plan = {
  id: string; title: string; remarks: string | null; status: PlanStatus;
  period_kind: PeriodKind; period_start: string; period_end: string;
  submission_deadline: string; submitted_at: string | null;
  created_by: string; updated_by: string; updated_at: string; created_at: string;
  approved_by: string | null; approved_at: string | null; decision_notes: string | null; revision: number;
};
export type PlanLine = {
  planning_level?: 'sku' | 'product';
  id: string; plan_id: string; po_detail_id: string | null; po_number: string; po_ref_num: string | null;
  product_code: string; product_variant: string | null; sku: string | null; size: string | null;
  vendor_name: string | null; expected_date: string; inward_qty: number; cost_per_piece: number | null;
  remarks: string | null;
};
export type InventorySize = { sku: string; size: string | null; current_stock: number | null; doq_45: number | null };
export type SourceLine = {
  inventory?: InventorySize[];
  po_detail_id: string; po_number: string; po_ref_num: string | null; product_code: string;
  product_variant: string | null; sku: string | null; size: string | null; vendor_name: string | null;
  pending_qty: number; item_price: number | null; expected_delivery_date: string | null;
};
export type HistoryEntry = {
  id: number; record_id: string; entity: string; operation: string;
  from_status: PlanStatus | null; to_status: PlanStatus | null; changed_by: string; changed_at: string;
  before_row: Record<string, unknown> | null; after_row: Record<string, unknown> | null;
};
export type ProductSource = { po_number: string; po_ref_num: string | null; product_code: string; vendor_name: string | null; pending_qty: number; item_price: number | null; expected_delivery_date: string | null };
export type LineDraft = {
  planning_level?: 'sku' | 'product'; po_number?: string;
  po_label?: string; vendor_name?: string; product_code?: string; sku?: string;
  id?: string; po_detail_id: string; expected_date: string; inward_qty: string;
  cost_per_piece: string; remarks: string; label: string;
};
export type HeaderDraft = { id?: string; title: string; remarks: string; period_kind: PeriodKind; period_start: string };
export type Result = { ok: boolean; message: string; id?: string; errors?: string[] };
export const STATUS_LABEL: Record<PlanStatus, string> = {
  draft: 'Draft', pending_l2: 'Approval Pending', approved: 'Approved',
  rework: 'Rework / Reassign', rejected: 'Rejected / Discarded',
};
