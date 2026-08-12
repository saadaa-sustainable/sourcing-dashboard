/**
 * Types for the write-side of the sourcing dashboard.
 *
 * These describe `sd_*` tables, which Supabase OWNS. They are never touched by
 * the Apps Script sheet sync — see the warning at the top of forms/actions.ts.
 */

import type { InternalStatus } from '@/lib/types';

// Two working roles:
//   admin — founders. Full access and can approve everything.
//   team  — supply-chain staff. Fill/submit forms and approve routine items.
// 'viewer' is not assigned to anyone; it is the automatic read-only state for a
// signed-in @saadaa.in account that has not been added to sd_user yet.
export type SdRole = 'viewer' | 'team' | 'admin';

export type SdStatus =
  | 'draft'
  | 'submitted'
  | 'pending_l2'
  | 'rework'
  | 'approved'
  | 'rejected';

export type SdUser = {
  email: string;
  full_name: string | null;
  role: SdRole;
  is_active: boolean;
};

/** Product-level master attributes the Buying Plan reads (sd_product_master). */
export type ProductMaster = {
  product_code: string;
  product_status: string | null;
  fabric_type: string | null;
  is_active: boolean;
  updated_at: string;
};

/** Fabric master — manually-coded composition records; feeds the Buying Plan datalist. */
export type FabricMaster = {
  fabric_code: string;
  composition: string | null;
  warp_count: string | null;
  weft_count: string | null;
  third_thread: string | null;
  weave: string | null;
  gsm: number | null;
  raw_material_color: string | null;
  fabric_name: string | null;
  is_active: boolean;
  updated_at: string;
};

/** Fabric cost base sheet row (sd_fabric_cost_base) — direct reference costing. */
export type FabricCostBase = {
  fabric_code: string;
  yarn_cost: number | null;
  conversion_cost: number | null;
  grey_rate: number | null;
  processing_cost: number | null;
  finished_fabric_cost: number | null;
  notes: string | null;
  updated_at: string;
};

export type MaterialType = 'raw' | 'dyed' | 'trim';

/** One row of the unified material master (raw fabric / dyed fabric / trim). */
export type MaterialMaster = {
  material_code: string;
  material_type: MaterialType;
  name: string | null;
  colour: string | null; // dyed only
  base_fabric_code: string | null; // dyed only
  default_uom: string | null;
  is_active: boolean;
  updated_at: string;
};

/** A managed colour, used to build dyed-fabric codes. */
export type Colour = { colour: string; is_active: boolean };

/** Active material code as consumed by the Buying Plan (sd_material_codes view). */
export type MaterialCode = {
  material_code: string;
  material_type: MaterialType;
  fabric_name: string | null;
  colour: string | null;
  base_fabric_code: string | null;
};

/** FG-master auto-rule: NPD-not-launched product with a colour selling >50 pcs. */
export type NpdPromotionCandidate = {
  product_code: string;
  product_name: string | null;
  qualifying_colours: number;
  top_colour_sales_45d: number;
  total_sales_45d: number;
  product_state: string | null;
};

/* ------------------------------------------------------------------ */
/* Buying Plan                                                         */
/* ------------------------------------------------------------------ */

export type BuyingPlan = {
  id: number;
  plan_month: string; // first day of month, ISO
  plan_type: 'fg' | 'material';
  status: SdStatus;
  submitted_by: string | null;
  submitted_at: string | null;
  approved_by: string | null;
  approved_at: string | null;
  rejection_notes: string | null;
  // True once an approver edited/reworked the plan before approving — drives the
  // "First-Time Approved" vs "Edited-and-Approved" distinction on the badge.
  edited_before_approval: boolean;
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
  uom: string | null; // material track only
  line_status: SdStatus | null; // per-line approval state (line-item granularity)
  rework_notes: string | null;
  remark: string | null; // free note, e.g. carried from a CSV import
  material_type: string | null; // material track: raw | dyed | trim
  job_rate: number | null; // material track: Job-Work rate (purchase rate = standard_value)
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
  week_of: string | null; // legacy — week bucketing dropped; kept nullable
  entry_date: string; // when this row was actually entered
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
  lastUpdated: string | null;
  isStale: boolean;
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

export type DiscontinueScope = 'size' | 'colour' | 'product';

export type DiscontinueRequest = {
  id: number;
  scope: DiscontinueScope;
  product_code: string;
  product_variant: string | null;
  size: string | null;
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

/** One colour/size line of a PO (sd_po_approval_line) — for line-item rework. */
export type PoApprovalLine = {
  id: number;
  po_id: number;
  product_variant: string | null;
  size: string | null;
  qty: number;
  line_status: SdStatus | null;
  rework_notes: string | null;
};

export type ApprovalEntity =
  | 'buying_plan'
  | 'discontinue'
  | 'po_approval'
  | 'standard_cost'
  | 'material_cost'
  | 'receivable_plan';

/** Standard cost sheet row — final job/FOB/EFOB rates per product (sd_standard_cost). */
export type StandardCost = {
  id: number;
  product_code: string;
  job_cost: number | null;
  fob_cost: number | null;
  efob_cost: number | null;
  // Documentation layer (FG): CM (stitching) cost, an entered Total PO Average
  // Cost, CAD/RFP document links, and whether this product was ever costed.
  cm_cost: number | null;
  total_po_avg_cost: number | null;
  cad_link: string | null;
  rfp_link: string | null;
  documented: boolean;
  fabric_code: string | null; // fabric whose rate feeds the CM cost matrix
  status: SdStatus;
  submitted_by: string | null;
  submitted_at: string | null;
  approved_by: string | null;
  approved_at: string | null;
  rejection_notes: string | null;
  frozen: boolean;
  frozen_at: string | null;
  updated_at: string;
  // Cost-negotiation lifecycle (its own process): propose → target → actual → sign-off.
  neg_stage: string | null;
  proposed_cost: number | null;
  target_cost: number | null;
  negotiation_notes: string | null;
  // Sequential sign-off (FG): fabric rate confirmed first, then CM/other second.
  fabric_confirmed_at: string | null;
  fabric_confirmed_by: string | null;
  cm_confirmed_at: string | null;
  cm_confirmed_by: string | null;
};

/** The document-once standard cost fields, same across all products (singleton). */
export type CostStandards = {
  id: number;
  fabric_cost: number | null;
  dyeing_cost: number | null;
  shrinkage_pct: number | null;
  margin_pct: number | null;
  payment_terms: string | null;
  updated_by: string | null;
  updated_at: string;
};

/** One colour×size cost line under a product's standard cost (sd_standard_cost_line). */
export type StandardCostLine = {
  id: number;
  product_code: string;
  colour: string | null;
  size: string | null;
  fabric_cost: number | null;
  cm_cost: number | null;
  total_cost: number | null;
};

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

/** One month of the cash-flow forecast (payment obligations coming due). */
export type CashFlowMonth = {
  due_month: string;
  received: number;   // invoiced GRN value, due invoice + terms
  projected: number;  // open-PO value, due EDD + terms
  total: number;
  items: number;
};

/** Vendor payment terms (days) — drives when a buying commitment becomes payable. */
export type VendorTerm = {
  vendor_code: string;
  vendor_name: string | null;
  payment_terms_days: number;
};

/** Replenishment / DOQ recommendation for one colour (product_variant). */
export type ReplenishmentRow = {
  product_variant: string;
  product_code: string | null;
  product_name: string | null;
  product_state: string | null;
  current_stock: number;
  in_progress: number;
  daily_demand: number;
  doq_45: number | null;
  oos_flag: boolean;
  rop_30: number;
  rop_60: number;
  rop_90: number;
};

/** One size-pivoted receivable row (open PO colour + DOQ/stock/OOS enrichment). */
export type ReceivablePlanRow = {
  row_key: string;
  po_number: string;
  po_ref_num: string | null;
  po_status: string | null;
  po_created_date: string | null;
  product_code: string | null;
  product_variant: string;
  vendor_name: string | null;
  vendor_code: string | null;
  expected_delivery_date: string | null;
  arriving_qty: number;
  size_xs: number | null;
  size_s: number | null;
  size_m: number | null;
  size_l: number | null;
  size_xl: number | null;
  size_2xl: number | null;
  size_3xl: number | null;
  size_4xl: number | null;
  size_5xl: number | null;
  product_state: string | null;
  doq_45: number | null;
  current_stock: number | null;
  sales_45d: number | null;
  oos_flag: boolean | null;
  // Live TNA/risk status (Overdue / High Risk / On Track), computed from the
  // merged tna_tracker + form actuals — same rule as the Open PO Tracker.
  internal_status: InternalStatus | null;
  // Current in-stock qty split by size (keyed size_xs…size_5xl), from the
  // inventory snapshot — so the arriving-by-size row has a stock-by-size row.
  stock_by_size: Record<string, number>;
  // Merged-in weekly inputs (sd_receivable_input).
  delivery_date_this_week: string | null;
  qty_expected_this_week: number | null;
  remarks: string | null;
  // When the weekly input for this row was last saved (drives the "last updated" stamp).
  input_updated_at: string | null;
};

/** One arriving-stock line for the Inward Plan (grouped PO × product × variant). */
export type InwardPlanGroup = {
  po_number: string;
  po_ref_num: string | null;
  product_code: string;
  product_variant: string;
  vendor_code: string;
  vendor_name: string;
  ordered_qty: number;
  arriving_qty: number;
  expected_delivery_date: string | null;
};

/** How the PO is placed. Descriptive — does not affect routing. */
export type PoType = 'FOB' | 'job_work' | 'efob';
/** What the PO is for. Drives approval routing (NPD/MAT → 2-level; FG by qty). */
export type PoCategory = 'fg' | 'mat' | 'npd';

/**
 * A PO raised for approval (the write-side of the PO Approval workflow).
 * Field set is the sheet-verified spec: 18 inputs + DiGiO-signed issuance fields.
 */
export type PoApproval = {
  id: number;
  timestamp_created: string;
  created_by: string | null;
  // inputs
  po_type: PoType | null;
  product_code: string | null;
  po_ref_num: string | null;
  vendor_code: string | null;
  vendor_name: string | null;
  tna_sheet_url: string | null;
  cost_sheet_url: string | null;
  po_qty: number;
  po_closing_date: string | null;
  cad_folder_url: string | null;
  cs_pp_sample_due: string | null;
  cs_gpt_due: string | null;
  cs_cutting_start: string | null;
  cs_inline_qc_due: string | null;
  critical_path_first_delivery: string | null;
  trim_card_signed: boolean;
  buying_plan_no: string | null;
  category: PoCategory;
  rate: number | null; // negotiated rate, filled with the cost sheet
  requested_total_days: number | null; // day-count as requested at submission (locked)
  // approval workflow
  status: SdStatus;
  submitted_for_approval_at: string | null;
  approved_by: string | null;
  approved_at: string | null;
  rejection_notes: string | null;
  // TNA gate — approver-confirmed critical-path dates; cost approval is blocked until true
  tna_confirmed: boolean;
  tna_confirmed_by: string | null;
  tna_confirmed_at: string | null;
  // issuance / DiGiO signing (phase 2 for the signed_* set)
  easycom_po_no: string | null;
  signed_po_document_url: string | null;
  signed_cost_sheet_url: string | null;
  signed_tna_url: string | null;
  signed_po_ref_number: string | null;
  date_of_po_sign: string | null;
  first_actual_delivery_date: string | null;
  po_issued_at: string | null;
  created_at: string;
};

/**
 * A "PO Details Form" (Google Form) submission — the sourcing/issuance metadata layer.
 * GCP/EasyEcom are the source of truth for the PO itself; matched_to_live_po flags
 * whether this ref is still in the live open pipeline. From sd_po_details.
 */
export type PoDetails = {
  source_row_key: string;
  submitted_at: string | null;
  merchandiser: string | null;
  po_type: string | null;
  product_code: string | null;
  po_number: string | null;
  easyecom_po_no: string | null;
  vendor_name: string | null;
  date_of_po_sign: string | null;
  no_of_colors: number | null;
  po_qty: number | null;
  po_closing_date: string | null;
  trim_card_signed: boolean | null;
  buying_plan_no: string | null;
  pp_sample_due: string | null;
  gpt_due: string | null;
  cutting_date: string | null;
  inline_qc_date: string | null;
  signed_po_document: string | null;
  signed_po_cost_sheet: string | null;
  signed_tna: string | null;
  tna_sheet_link: string | null;
  cad_folder_link: string | null;
  vendor_master_sheet_link: string | null;
  matched_to_live_po: boolean;
};

/** Cycle-time row from sd_po_cycle_time (days per lifecycle stage). */
export type PoCycleTime = {
  id: number;
  days_to_approve: number | null;
  days_to_issue: number | null;
  total_cycle_days: number | null;
  days_to_sign: number | null;
  total_cycle_days_signoff: number | null;
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
  // Line items (Buying Plan / PO Approval) for line-item rework and, for the
  // Buying Plan, per-line multi-select approval + the Woven/Knitted pivot.
  lines?: {
    id: string;
    label: string;
    qty?: number;
    value?: number;
    fabricType?: string | null;
    lineStatus?: SdStatus | null;
  }[];
  // PO Approval only: the vendor's live capacity, shown on the card so the
  // approver sees the load and the last-updated signed capacity before deciding.
  vendorCode?: string | null;
  vendorInProcessQty?: number | null;
  vendorCapacityPerMonth?: number | null;
  vendorCapacityUpdatedAt?: string | null;
  // PO Approval only: the inline "4 things Mahesh verifies" detail.
  poDetail?: PoApprovalDetail;
};

/** A SKU line under an open PO, for the submission/closure table. */
export type PoSubmissionLine = {
  sku: string | null;
  product_variant: string | null;
  size: string | null;
  original_qty: number;
  pending_qty: number;
  item_price: number | null;
  expected_delivery_date: string | null;
};

/** One open PO grouped for the submission/closure table (SKU-wise expandable). */
export type PoSubmissionGroup = {
  po_number: string;
  po_ref_num: string | null;
  vendor_code: string | null;
  vendor_name: string | null;
  po_date: string | null;
  expected_delivery_date: string | null;
  product_codes: string[];
  original_qty: number;
  pending_qty: number;
  closureStatus: SdStatus;
  lines: PoSubmissionLine[];
};

/** Standard TNA lead-times (singleton) used to auto-generate the critical path. */
export type TnaLeadtimes = {
  id: number;
  pp_sample_days: number | null;
  gpt_days: number | null;
  cutting_days: number | null;
  inline_qc_days: number | null;
  first_delivery_days: number | null;
  po_closing_days: number | null;
  updated_by: string | null;
  updated_at: string;
};

/** The 4-tab verification detail shown inline on a PO approval card. */
export type PoApprovalDetail = {
  productCode: string | null;
  poType: PoType | null;
  poQty: number;
  writtenRate: number | null;
  stdCost: { job: number; fob: number; efob: number } | null;
  inventory: {
    currentStock: number;
    inProgress: number;
    dailyQty: number;
    doq45: number;
    daysOfStock: number | null;
  } | null;
  tna: {
    poClosingDate: string | null;
    ppSampleDue: string | null;
    gptDue: string | null;
    cuttingStart: string | null;
    inlineQcDue: string | null;
    firstDelivery: string | null;
    requestedTotalDays: number | null;
    tnaConfirmed: boolean;
  };
};
