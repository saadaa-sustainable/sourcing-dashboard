/**
 * Types for the write-side of the sourcing dashboard.
 *
 * These describe `sd_*` tables, which Supabase OWNS. They are never touched by
 * the Apps Script sheet sync — see the warning at the top of forms/actions.ts.
 */

export type SdRole =
  | 'viewer'
  | 'supply_chain'
  | 'approver_l1'
  | 'approver_l2'
  | 'admin';

export type SdStatus =
  | 'draft'
  | 'submitted'
  | 'pending_l2'
  | 'approved'
  | 'rejected';

export type SdUser = {
  email: string;
  full_name: string | null;
  role: SdRole;
  is_active: boolean;
};

/* ------------------------------------------------------------------ */
/* Buying Plan                                                         */
/* ------------------------------------------------------------------ */

export type BuyingPlan = {
  id: number;
  plan_month: string; // first day of month, ISO
  status: SdStatus;
  submitted_by: string | null;
  submitted_at: string | null;
  approved_by: string | null;
  approved_at: string | null;
  rejection_notes: string | null;
  created_at: string;
};

export type BuyingPlanLine = {
  id: number;
  plan_id: number;
  product_code: string;
  product_status: string | null;
  fabric_type: string | null; // Woven | Knit
  pending_quantity: number | null;
  job_work_qty: number;
  fob_qty: number;
  efob_qty: number;
  standard_value: number | null;
};

/** Everything derived. Never stored — same discipline as business-logic.ts. */
export type BuyingPlanLineView = BuyingPlanLine & {
  totalQty: number;
  valueToBeBought: number;
  actualIssuedQty: number;
  actualIssuedValue: number;
  overPlan: boolean;
};

/* ------------------------------------------------------------------ */
/* Vendor Capacity                                                     */
/* ------------------------------------------------------------------ */

export type VendorCapacityLog = {
  id: number;
  vendor_code: string;
  vendor_name: string | null;
  week_of: string; // Monday, ISO
  machines_allocated: number | null;
  active_karigar: number | null;
  capacity_per_month: number | null;
  machines_at_onboarding: number | null;
  capacity_signed: number | null;
  submitted_by: string;
  submitted_at: string;
};

export type VendorCapacityView = VendorCapacityLog & {
  vendorType: string;
  multiplier: number;
  stockDays: number;
  inProcessQty: number;
  poCapacity: number;
  availablePoCapacity: number;
  overProduction: boolean;
  machineUtilisationPct: number;
  capacityUtilisationPct: number;
};

export type VendorTypeMultiplier = {
  vendor_type: string;
  label: string;
  multiplier: number;
  stock_days: number;
};

/* ------------------------------------------------------------------ */
/* Discontinue                                                         */
/* ------------------------------------------------------------------ */

export type DiscontinueRequest = {
  id: number;
  product_code: string;
  product_variant: string;
  reason: string | null;
  status: SdStatus;
  requested_by: string | null;
  requested_at: string | null;
  approved_by: string | null;
  approved_at: string | null;
  rejection_notes: string | null;
};

/* ------------------------------------------------------------------ */
/* Approval log                                                        */
/* ------------------------------------------------------------------ */

export type ApprovalEntity = 'buying_plan' | 'discontinue' | 'po_approval';

export type ApprovalLogRow = {
  id: number;
  entity_type: ApprovalEntity;
  entity_id: string;
  entity_label: string | null;
  from_status: SdStatus | null;
  to_status: SdStatus;
  actor_email: string;
  notes: string | null;
  created_at: string;
};

/** One row in the unified /approvals queue. */
export type ApprovalQueueItem = {
  entityType: ApprovalEntity;
  entityId: string;
  label: string;
  sublabel: string;
  status: SdStatus;
  quantity: number;
  requiredRole: SdRole;
  submittedBy: string | null;
  submittedAt: string | null;
  href: string;
};
