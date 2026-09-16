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
  | 'not_approved'; // issued, in the plan but with no approved quantity — line never approved, or approved at zero (exception a)

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

/** Month-end lifecycle facts for the plan (spec item 5). */
export type BuyingPlanLifecycle = {
  frozen: boolean; // month ended → no direct edits, no PO linkage
  frozenSince: string | null; // ISO date of the freeze (1st of the next month) when frozen
  submittedAt: string | null;
  approvedAt: string | null;
  /** First admin decision on this submission (approve / reject / rework) — what the deadline measures. */
  firstActionAt: string | null;
  compliance: {
    deadline: string; // ISO instant
    deadlineDay: number; // Rules Master: plan_approval_deadline_day
    status: 'on_time' | 'pending' | 'breach_submission' | 'breach_approval';
    daysLate: number;
  };
  /** This plan's approval quality. */
  approvalKind: 'first_time' | 'edited' | 'amended_after_freeze' | 'not_approved';
  /** Trailing-6-month plan-level first-time approval rate (approved plans only). */
  firstTimeRate: { firstTime: number; approved: number; months: string[] };
  /** Which Slack webhook the month report will post to (dedicated, a fallback, or none). */
  slackTarget: 'supply_chain' | 'ops' | 'feedback' | 'none';
  /** Latest generated month report, if any. */
  report: {
    generatedAt: string;
    generatedBy: string | null;
    slackPostedAt: string | null;
    slackError: string | null;
    storagePath: string;
  } | null;
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
  lifecycle: BuyingPlanLifecycle;
};

/**
 * Is a product in a month's buying plan? (spec item 6 — display only, never a gate.)
 * "In plan" means an approved line with quantity; a line that exists but was never
 * approved (or has zero qty) is reported as in the plan but not budgeted.
 */
export type PlanMembership = {
  planMonth: string; // ISO first-of-month the check ran against
  planExists: boolean; // a FG plan exists for that month
  planStatus: SdStatus | null;
  inPlan: boolean; // approved line with qty > 0
  linePresent: boolean; // any line for the product (approved or not)
  lineApproved: boolean;
  qty: { job: number; fob: number; efob: number; total: number };
};
