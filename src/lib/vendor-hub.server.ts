import { loadDeboardedVendors, loadVendorCapacity, loadVendorOtif } from '@/lib/forms/queries';
import type { DeboardedVendor } from '@/lib/forms/types';
import type { DashboardData } from '@/lib/types';

/**
 * Vendor objective one-pager (DAM principle: one base dimension = Vendor, full picture
 * around it). Consolidates the vendor-anchored facets that today live as separate
 * Main-Dashboard cards — concentration/risk, delivery reliability, capacity, and OTIF
 * scoring — into one per-vendor scorecard. Assembled by REUSING existing loaders
 * (buildVendorRollups via loadVendorCapacity + loadVendorOtif); no recomputation, no
 * touch to the confirmed-correct source cards.
 */
export type VendorHubRow = {
  vendorCode: string;
  vendorName: string;
  weave: 'Woven' | 'Knit' | 'Other';
  // Concentration / workload
  openPoCount: number;
  openQty: number;
  openValue: number;
  sharePct: number; // share of total open value
  // Reliability
  delayedPoCount: number;
  delayPct: number;
  // Capacity (the one model): monthly, and what fits inside the PO type's lead time.
  capacityPerMonth: number;
  poCapacity: number;
  capacityEntered: boolean;
  utilizationPct: number;
  // OTIF scoring (window-based; null when the vendor has no rated POs)
  otifPct: number | null;
  onTimePct: number | null;
  fillPct: number | null;
  ratedPos: number;
  /** Set when the team has approved de-boarding this vendor. */
  deboarded: DeboardedVendor | null;
};

export type VendorHubData = {
  windowDays: number;
  rows: VendorHubRow[];
  summary: {
    vendors: number;
    top3ConcentrationPct: number;
    avgOtifPct: number | null; // weighted by rated POs
    worstDelay: { vendorName: string; delayPct: number } | null;
    overUtilised: number; // vendors above 100% capacity
  };
};

/** `pre.dash` lets the dashboard page hand over what it has already loaded. */
export async function loadVendorHub(windowDays = 180, pre?: { dash?: DashboardData }): Promise<VendorHubData> {
  const [cap, otif, deboarded] = await Promise.all([
    loadVendorCapacity(pre?.dash),
    loadVendorOtif(windowDays, pre?.dash),
    loadDeboardedVendors(),
  ]);

  const otifByCode = new Map(
    otif.vendors.map((v) => [String(v.vendorCode ?? v.vendorName), v]),
  );

  const rollups = cap.rollups.filter((r) => r.openValue > 0 || r.openPoCount > 0);
  const totalOpenValue = rollups.reduce((s, r) => s + r.openValue, 0);

  const rows: VendorHubRow[] = rollups
    .map((r) => {
      const o = otifByCode.get(String(r.vendorCode || r.vendorName));
      return {
        vendorCode: r.vendorCode,
        vendorName: r.vendorName,
        weave: r.vendorBucket,
        openPoCount: r.openPoCount,
        openQty: r.openQty,
        openValue: r.openValue,
        sharePct: totalOpenValue > 0 ? (r.openValue / totalOpenValue) * 100 : 0,
        delayedPoCount: r.delayedPoCount,
        delayPct: r.delayPct,
        capacityPerMonth: r.capacityPerMonth,
        poCapacity: r.poCapacity,
        capacityEntered: r.capacityEntered,
        utilizationPct: r.utilizationPct,
        otifPct: o ? o.otifPct : null,
        onTimePct: o ? o.onTimePct : null,
        fillPct: o ? o.fillPct : null,
        ratedPos: o ? o.pos : 0,
        deboarded: deboarded[String(r.vendorCode ?? '').trim().toUpperCase()] ?? null,
      };
    })
    .sort((a, b) => b.openValue - a.openValue);

  // Rollups are per vendor × weave; the summary is per VENDOR (a dual-weave vendor
  // is one vendor, one OTIF record, one concentration slot).
  const byVendor = new Map<string, { openValue: number; otifPct: number | null; ratedPos: number }>();
  for (const r of rows) {
    const k = String(r.vendorCode || r.vendorName);
    const cur = byVendor.get(k);
    if (cur) cur.openValue += r.openValue;
    else byVendor.set(k, { openValue: r.openValue, otifPct: r.otifPct, ratedPos: r.ratedPos });
  }
  const vendors = [...byVendor.values()].sort((a, b) => b.openValue - a.openValue);
  const top3 = vendors.slice(0, 3).reduce((s, r) => s + r.openValue, 0);
  const rated = vendors.filter((r) => r.ratedPos > 0);
  const otifNumer = rated.reduce((s, r) => s + (r.otifPct ?? 0) * r.ratedPos, 0);
  const otifDenom = rated.reduce((s, r) => s + r.ratedPos, 0);
  const worst = rows
    .filter((r) => r.openPoCount > 0)
    .reduce<{ vendorName: string; delayPct: number } | null>(
      (acc, r) => (acc == null || r.delayPct > acc.delayPct ? { vendorName: r.vendorName, delayPct: r.delayPct } : acc),
      null,
    );

  return {
    windowDays,
    rows,
    summary: {
      vendors: byVendor.size,
      top3ConcentrationPct: totalOpenValue > 0 ? Math.round((top3 / totalOpenValue) * 100) : 0,
      avgOtifPct: otifDenom > 0 ? otifNumer / otifDenom : null,
      worstDelay: worst,
      overUtilised: rows.filter((r) => r.utilizationPct > 100).length,
    },
  };
}
