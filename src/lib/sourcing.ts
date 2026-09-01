import { loadDashboardData } from '@/lib/data';
import { buildTrackerRows } from '@/lib/business-logic';

/**
 * Sourcing role dashboard — one row per open PO, rolled up from the tracker's
 * PO × product rows. Total Qty is the ordered quantity across all lines; EDD is
 * the earliest expected delivery; TNA is the current production stage (the
 * earliest stage without an actual date), or "No TNA" when no timeline exists.
 */
export type SourcingPoRow = {
  poNumber: string;
  vendorName: string;
  vendorCode: string;
  merchant: string;
  totalQty: number;
  pendingQty: number;
  tnaStage: string;
  tnaMissing: boolean;
  edd: string | null;
  delayDays: number;
};

export async function loadSourcingPos(): Promise<{
  rows: SourcingPoRow[];
  warnings: string[];
}> {
  const data = await loadDashboardData();
  const tracker = buildTrackerRows(
    data.pendingPos,
    data.vendorTypes,
    data.vendorMasters,
    data.tnaRecords,
  );
  const byPo = new Map<string, SourcingPoRow>();
  for (const r of tracker) {
    const cur = byPo.get(r.poRef);
    if (!cur) {
      byPo.set(r.poRef, {
        poNumber: r.poNumber,
        vendorName: r.vendorName,
        vendorCode: r.vendorCode,
        merchant: r.merchant,
        totalQty: r.orderedQty,
        pendingQty: r.pendingQty,
        tnaStage: r.tnaMissing ? 'No TNA' : r.stage,
        tnaMissing: r.tnaMissing,
        edd: r.edd,
        delayDays: r.delayDays,
      });
    } else {
      cur.totalQty += r.orderedQty;
      cur.pendingQty += r.pendingQty;
      if (r.edd && (!cur.edd || r.edd < cur.edd)) cur.edd = r.edd;
      if (r.delayDays > cur.delayDays) cur.delayDays = r.delayDays;
    }
  }
  // Worst delays first, then by soonest EDD.
  const rows = [...byPo.values()].sort(
    (a, b) =>
      b.delayDays - a.delayDays ||
      (a.edd ?? '9999').localeCompare(b.edd ?? '9999'),
  );
  return { rows, warnings: data.warnings };
}
