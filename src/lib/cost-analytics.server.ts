import { createClient } from '@/lib/supabase/server';

/**
 * Items 3 & 4 — Standard Cost vs Actual Cost analytics dataset. One row per PO that
 * carries a submitted rate, with:
 *   • standard  — the approved standard cost for the product (by PO type)
 *   • expected  — the live-recomputed expected FINAL price stamped at issuance
 *                 (sd_po_approval.expected_cost_recomputed; the discrepancy basis
 *                 per the recompute spec — NOT a second calculation), falling back
 *                 to the standard when a PO predates the recompute.
 *   • actual    — the vendor's submitted per-unit rate (sd_po_approval.rate)
 *   • delta     — actual − expected (per unit); deltaValue = delta × qty
 * The same rows are sliced by vendor / product / category in the UI, and filtered to
 * po_type='efob' for the EFOB lens. Dormant until PO cost + standard cost data lands.
 */
export type CostAnalyticsRow = {
  poRef: string | null;
  productCode: string | null;
  vendorCode: string | null;
  vendorName: string | null;
  category: string | null;
  poType: string | null;
  qty: number;
  standard: number | null;
  expected: number | null;
  actual: number | null;
  delta: number | null; // per unit; +over standard, −under
  deltaPct: number | null;
  deltaValue: number | null; // delta × qty
  issuedAt: string | null;
};

type StdRow = {
  product_code: string;
  job_cost: number | null;
  fob_cost: number | null;
  efob_cost: number | null;
  total_po_avg_cost: number | null;
};

/** Pick the standard cost that matches the PO's type, falling back to the blended. */
function standardFor(poType: string | null, sc: StdRow | undefined): number | null {
  if (!sc) return null;
  const t = (poType ?? '').toLowerCase();
  const pick =
    t.includes('efob') ? sc.efob_cost :
    t.includes('fob') ? sc.fob_cost :
    t.includes('job') ? sc.job_cost :
    null;
  const val = pick ?? sc.total_po_avg_cost ?? sc.fob_cost ?? sc.efob_cost ?? sc.job_cost;
  return val == null ? null : Number(val);
}

export async function loadCostAnalytics(): Promise<CostAnalyticsRow[]> {
  const supabase = await createClient();

  const [{ data: pos }, { data: stds }, { data: cats }] = await Promise.all([
    supabase
      .from('sd_po_approval')
      .select('po_ref_num, product_code, vendor_code, vendor_name, po_type, po_qty, rate, expected_cost_recomputed, po_issued_at')
      .not('rate', 'is', null),
    supabase
      .from('sd_standard_cost')
      .select('product_code, job_cost, fob_cost, efob_cost, total_po_avg_cost'),
    supabase.from('sd_product_catalog').select('product_code, category'),
  ]);

  const stdByCode = new Map<string, StdRow>(
    (stds ?? []).map((s) => [String(s.product_code), s as StdRow]),
  );
  const catByCode = new Map<string, string | null>(
    (cats ?? []).map((c) => [String(c.product_code), (c.category as string | null) ?? null]),
  );

  return (pos ?? []).map((po) => {
    const code = po.product_code == null ? null : String(po.product_code);
    const sc = code ? stdByCode.get(code) : undefined;
    const standard = standardFor(po.po_type as string | null, sc);
    const expectedRecomputed =
      po.expected_cost_recomputed == null ? null : Number(po.expected_cost_recomputed);
    const expected = expectedRecomputed ?? standard;
    const actual = po.rate == null ? null : Number(po.rate);
    const qty = Number(po.po_qty || 0);
    const delta = expected != null && actual != null ? actual - expected : null;
    const deltaPct = delta != null && expected ? (delta / expected) * 100 : null;
    return {
      poRef: (po.po_ref_num as string | null) ?? null,
      productCode: code,
      vendorCode: (po.vendor_code as string | null) ?? null,
      vendorName: (po.vendor_name as string | null) ?? null,
      category: code ? catByCode.get(code) ?? null : null,
      poType: (po.po_type as string | null) ?? null,
      qty,
      standard,
      expected,
      actual,
      delta,
      deltaPct,
      deltaValue: delta != null ? delta * qty : null,
      issuedAt: (po.po_issued_at as string | null) ?? null,
    };
  });
}
