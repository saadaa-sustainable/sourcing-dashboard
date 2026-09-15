// Client-safe types for the Buying Plan Analysis track (approved plan vs issued POs, per
// month). Everything here is derived at read time by loadBuyingPlanAnalysis (server) and
// never stored — same discipline as business-logic.ts. Kept in its own file so client
// components can import the shapes without touching server-only modules.

import type { SdStatus } from './types';

/** One issued EasyEcom PO (aggregated to the product) inside the analysed month. */
export type BuyingPlanAnalysisPo = {
  po_id: string;
  po_number: string | null;
  po_ref_num: string | null;
  po_type: string | null; // FOB | JOB | EFOB, from the PO reference
  vendor_code: string | null;
  vendor_name: string | null;
  po_date: string | null;
  qty: number;
  value: number;
};

export type BuyingPlanAnalysisStatus =
  | 'on_plan' // issued == approved
  | 'over' // issued > approved  (exception b)
  | 'short' // issued < approved, something issued
  | 'unissued' // approved, nothing issued
  | 'not_planned' // issued, product absent from the plan (exception a)
  | 'not_approved'; // issued, in the plan but the line was never approved (exception a)

export type BuyingPlanAnalysisProduct = {
  product_code: string;
  status: BuyingPlanAnalysisStatus;
  plannedQty: number; // approved lines only
  plannedValue: number; // approved qty × standard value
  issuedQty: number;
  issuedValue: number;
  deltaQty: number; // issued − planned
  deltaValue: number;
  poCount: number; // distinct issued POs for this product
  pos: BuyingPlanAnalysisPo[];
};

export type BuyingPlanAnalysisMetrics = {
  plannedQty: number;
  issuedQty: number;
  qtyVarPct: number | null;
  plannedValue: number;
  issuedValue: number;
  valueVarPct: number | null;
  plannedPoCount: number; // approved product × PO-type cells with qty > 0
  actualPoCount: number; // distinct issued POs in the month
  excessQty: number; // Σ (issued − approved) where issued > approved
  excessValue: number;
  excessPct: number | null; // excessQty / plannedQty
  shortQty: number; // Σ (approved − issued) where issued < approved
  shortValue: number;
  shortPct: number | null; // shortQty / plannedQty
  approvedProducts: number;
  issuedProducts: number;
};

export type BuyingPlanAnalysis = {
  planMonth: string;
  hasPlan: boolean;
  planStatus: SdStatus | null;
  approvedLines: number;
  totalLines: number;
  metrics: BuyingPlanAnalysisMetrics;
  products: BuyingPlanAnalysisProduct[];
  exceptions: {
    notBudgeted: BuyingPlanAnalysisProduct[]; // (a) not in plan, or in plan but never approved
    overApproved: BuyingPlanAnalysisProduct[]; // (b) issued above approved
  };
};
