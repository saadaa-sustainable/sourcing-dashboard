// Client-safe shapes for Vendor Capacity's monthly analysis (user, 2026-10-09: "Weekly input,
// monthly analysis. Mandatory monthly report to management."). Built at read time by
// loadVendorCapacityMonth (server) from the weekly entries; never stored.

/** One Monday-to-Sunday week of the month (a week belongs to the month its Monday falls in). */
export type VcmWeek = {
  week: string; // Monday, YYYY-MM-DD
  label: string; // "5 – 11 Oct"
  /** Active vendors who updated capacity in this week. */
  updated: number;
  active: number;
  /** Σ capacity per month as declared by the end of the week (pcs). */
  capacityPerMonth: number;
  /** Σ PO capacity (capacity over each vendor's PO-type lead time) by the end of the week. */
  poCapacity: number;
  /** Σ quantity on order at the end of the week; null when no weekly copy was kept. */
  onOrder: number | null;
  /** on order ÷ PO capacity × 100 (vendors with capacity entered); null without a copy. */
  util: number | null;
  /** Vendors past their PO capacity that week; null without a copy. */
  overVendors: number | null;
  /** The week is still running (current week of the running month). */
  running: boolean;
};

export type VcmVendor = {
  code: string;
  name: string;
  type: string | null;
  /** Signed capacity per month at onboarding (vendor master). */
  signed: number;
  weeksUpdated: number;
  weeksExpected: number;
  /** Capacity per month at the end of the first and the last week of the month. */
  capStart: number | null;
  capEnd: number | null;
  poCapEnd: number | null;
  onOrderEnd: number | null;
  /** Mean / highest weekly utilisation over weeks with a copy and capacity entered. */
  avgUtil: number | null;
  peakUtil: number | null;
  weeksOver: number;
  lastUpdate: string | null;
};

export type VendorCapacityMonth = {
  month: string; // YYYY-MM-01
  label: string; // "October 2026"
  closed: boolean;
  weeks: VcmWeek[];
  vendors: VcmVendor[];
  totals: {
    active: number;
    vendorWeeksUpdated: number;
    vendorWeeksExpected: number;
    /** vendorWeeksUpdated ÷ vendorWeeksExpected × 100. */
    compliancePct: number | null;
    /** Active vendors with no update in any week of the month. */
    neverUpdated: number;
    /** Vendors over capacity in at least one week with a copy. */
    overAnyWeek: number;
    capStart: number;
    capEnd: number;
    poCapEnd: number;
    onOrderEnd: number | null;
    utilEnd: number | null;
  };
  /** What the figures can and cannot say (trail start, weeks without a copy …). */
  notes: string[];
  generatedAt: string;
};

/** Registry row of the month's report to management (sd_plan_report, plan_type 'vendor_capacity'). */
export type VendorCapacityReportStatus = {
  generatedAt: string;
  generatedBy: string | null;
  slackPostedAt: string | null;
  slackError: string | null;
  storagePath: string;
} | null;
