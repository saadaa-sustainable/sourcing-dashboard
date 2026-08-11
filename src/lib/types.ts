export type PendingPo = {
  source_row_key?: string;
  po_number: string | null;
  po_created_date: string | null;
  po_date: string | null;
  item_price: number;
  po_id: string | null;
  sku: string | null;
  product_description: string | null;
  cp_id: string | null;
  po_detail_id: string | null;
  original_quantity: number;
  pending_quantity: number;
  size: string | null;
  po_status: string | null;
  vendor_name: string | null;
  vendor_code: string | null;
  expected_delivery_date: string | null;
  po_ref_num: string | null;
  product_variant: string | null;
  product_code: string | null;
  pending_qty_actual: number;
  po_type: string | null;
  match_flag: boolean;
};

export type VendorType = {
  vendor_name: string;
  vendor_code: string | null;
  vendor_type: string | null;
  merchant_name: string | null;
  status: string | null;
};

export type VendorMaster = {
  vendor_code: string;
  vendor_name: string | null;
  onboarding_date: string | null;
  merchant_name: string | null;
  primary_type: string | null;   // JOB | FOB | EFOB | EFOB/FOB — frozen at onboarding
  total_machines: number;
  total_active_karigar: number;
  machines_for_saadaa: number;    // machines committed to SAADAA at onboarding
  capacity_per_month: number;     // signed monthly capacity at onboarding
  karigar_latest: number;
  karigar_latest_as_of: string | null;
};

export type TnaRecord = {
  po_no: string;
  po_issued_date: string | null;
  po_qty: number;
  pp_sample_tna_date: string | null;
  pp_sample_actual_date: string | null;
  pp_sample_delay_days: number;
  gpt_tna_date: string | null;
  gpt_actual_date: string | null;
  gpt_delay_days: number;
  cutting_tna_date: string | null;
  cutting_actual_date_first: string | null;
  cutting_delay_days: number;
  in_line_tna_date: string | null;
  in_line_actual_date: string | null;
  in_line_qc_delay_days: number;
  // Richer TNA Update milestones (from the merged "TNA Update" sheet). Optional
  // because the current mirror only carries the four core stages — these flow
  // through once the ingestion pulls the TNA Update columns.
  first_delivery_tna_date?: string | null;
  first_delivery_actual_date?: string | null;
  first_delivery_delay_days?: number;
  po_closer_tna_date?: string | null;
  po_closer_actual_date?: string | null;
  po_closer_delay_days?: number;
  grn_qty?: number;
  pending_qty?: number;
  current_production_stage?: string | null;
  total_delay_days?: number | null;
};

export type StageInspectionEntry = {
  actualDate: string | null;
  submittedAt: string | null;
  result: 'pass' | 'fail' | null;
  reportUrl: string | null;
  remarks: string | null;
};

// Per-stage inspection rollup for one PO (from sd_po_stage_inspections). Forms log
// both fail and pass entries; passDate is the pass, count is total attempts.
export type StageInspection = {
  passDate: string | null;
  reportUrl: string | null;
  count: number;
  failCount: number;
  entries: StageInspectionEntry[];
};

// Keyed by stage token (pp | gpt | cutting | inline | closer).
export type StageInspections = Partial<Record<string, StageInspection>>;

export type DashboardData = {
  pendingPos: PendingPo[];
  vendorTypes: VendorType[];
  vendorMasters: VendorMaster[];
  tnaRecords: TnaRecord[];
  // Per-PO, per-stage inspection detail (pass/fail entries, report links) keyed by
  // normalized (UPPER) PO ref; powers the tracker inline TNA breakdown.
  stageInspections?: Record<string, StageInspections>;
  source: 'supabase' | 'fixtures';
  warnings: string[];
  loadedAt: string;
};

export type EasycomStatus = 'Approved' | 'Partially Received' | 'Closure Pending';

export type InternalStatus =
  | 'On Track'
  | 'High Risk'
  | 'Overdue';

export type TrackerRow = {
  key: string;
  poRef: string;
  poNumber: string;
  productCode: string;
  vendorName: string;
  vendorCode: string;
  merchant: string;
  vendorBucket: 'Woven' | 'Knit';
  poType: string;
  variantCount: number;
  variantName: string;
  pendingQty: number;
  pendingValue: number;
  edd: string | null;
  delayDays: number;
  delayBucket: string;
  stage: string;
  // High risk = any critical-path TNA stage overdue as of today (Mahesh's rule).
  highRisk: boolean;
  // A TNA critical-path stage is planned for today and not yet done (Layer 3 - act now).
  dueToday: boolean;
  // Four status dimensions (see business-logic): live EasyCom status refined
  // with partial-delivery, and the single internal computed status.
  orderedQty: number;
  receivedQty: number;
  easycomStatus: EasycomStatus;
  internalStatus: InternalStatus;
  // True when a later TNA stage is completed while an earlier one is still blank
  // (strictly-linear violation) — surfaced as a data-entry error in the tracker.
  sequenceError: boolean;
  tnaMissing: boolean;
  skuRows: PendingPo[];
  tna: TnaRecord | null;
  // Per-stage inspection detail for the inline TNA breakdown (optional; present
  // only when form inspection data exists for this PO).
  inspections?: StageInspections;
};

// A single TNA milestone (stage) of an open PO that is not yet done, surfaced
// as an "event": due today (planned date is today) or delayed (planned date has
// passed). Same per-stage rule as the High Risk flag.
export type TnaEvent = {
  key: string;
  poRef: string;
  productCode: string;
  vendorName: string;
  vendorCode: string;
  merchant: string;
  stage: string;
  plannedDate: string;
  status: 'today' | 'delayed';
  overdueDays: number;
  row: TrackerRow;
};

export type VendorRollup = {
  vendorCode: string;
  vendorName: string;
  merchant: string;
  vendorBucket: 'Woven' | 'Knit';
  openPoCount: number;
  delayedPoCount: number;
  delayPct: number;
  openQty: number;
  openValue: number;
  totalMachines: number;
  totalActiveKarigar: number;
  karigarLatest: number;
  capacityPerMonth: number;
  utilizationPct: number;
};
