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
  total_machines: number;
  total_active_karigar: number;
  machines_for_saadaa: number;
  capacity_per_month: number;
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
};

export type DashboardData = {
  pendingPos: PendingPo[];
  vendorTypes: VendorType[];
  vendorMasters: VendorMaster[];
  tnaRecords: TnaRecord[];
  source: 'supabase' | 'fixtures';
  warnings: string[];
  loadedAt: string;
};

export type TrackerRow = {
  key: string;
  poRef: string;
  productCode: string;
  vendorName: string;
  vendorCode: string;
  merchant: string;
  vendorBucket: 'Woven' | 'Knit';
  poType: string;
  variantCount: number;
  pendingQty: number;
  pendingValue: number;
  edd: string | null;
  delayDays: number;
  delayBucket: string;
  stage: string;
  skuRows: PendingPo[];
  tna: TnaRecord | null;
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
