import { loadVendorCapacity, loadVendorOtif } from '@/lib/forms/queries';

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
  // Capacity
  capacityPerMonth: number;
  utilizationPct: number;
  // OTIF scoring (window-based; null when the vendor has no rated POs)
  otifPct: number | null;
  onTimePct: number | null;
  fillPct: number | null;
  ratedPos: number;
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

export async function loadVendorHub(windowDays = 180): Promise<VendorHubData> {
  const [cap, otif] = await Promise.all([
    loadVendorCapacity(),
    loadVendorOtif(windowDays),
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
        utilizationPct: r.utilizationPct,
        otifPct: o ? o.otifPct : null,
        onTimePct: o ? o.onTimePct : null,
        fillPct: o ? o.fillPct : null,
        ratedPos: o ? o.pos : 0,
      };
    })
    .sort((a, b) => b.openValue - a.openValue);

  const top3 = rows.slice(0, 3).reduce((s, r) => s + r.openValue, 0);
  const rated = rows.filter((r) => r.ratedPos > 0);
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
      vendors: rows.length,
      top3ConcentrationPct: totalOpenValue > 0 ? Math.round((top3 / totalOpenValue) * 100) : 0,
      avgOtifPct: otifDenom > 0 ? otifNumer / otifDenom : null,
      worstDelay: worst,
      overUtilised: rows.filter((r) => r.utilizationPct > 100).length,
    },
  };
}
