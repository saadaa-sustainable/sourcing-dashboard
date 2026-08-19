// Client-safe types & constants for the PO Manual Adjustment tab. Kept separate
// from adjustments.ts so client components can import them without pulling in the
// server-only BigQuery / Supabase modules.

export type AdjustmentSource = 'po' | 'cutting';

export const REFRESH_LIMIT_PER_HOUR = 2;
export const REFRESH_WINDOW_MS = 60 * 60 * 1000;
export const LATEST_N = 10;

export interface ManualAdjustmentRow {
  po_no: string | null;
  sku_code: string | null;
  manual_adjust_qty: number | null;
  po_type: string | null;
  ingestion_date: string | null;
  ingestion_by: string | null;
}

export interface CuttingRegisterRow {
  date_of_cutting: string | null;
  vendor_code: string | null;
  po_number: string | null;
  fabric_sku_code: string | null;
  item_code: string | null;
  cutting_qty: number | null;
  avg_fabric_consumption_approved: number | null;
  width_of_fabric: string | null;
  cutting_approval_sheet: string | null;
  remarks_of_cutting: string | null;
  fabric_consumed: number | null;
  type_of_po: string | null;
  date_of_ingestion: string | null;
  ingestion_by: string | null;
}

export interface RefreshState {
  remaining: number;
  retryAfterMinutes: number; // >0 only when remaining is 0
}

export interface RefreshResult {
  ok: boolean;
  source: AdjustmentSource;
  rows: Record<string, unknown>[];
  remaining: number;
  retryAfterMinutes: number;
  error?: string;
}
