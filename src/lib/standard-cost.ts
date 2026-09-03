/**
 * Standard Cost — live-recompute validation (spec §4 of the Buying-Plan /
 * Standard-Cost fix, 2026-09-03).
 *
 * The problem: comparing a vendor's submitted cost against the ORIGINAL frozen
 * standard total false-flags every time a commodity rate (grey / finished-fabric
 * / EFOB) moves — which is routine market behaviour, not an error.
 *
 * The fix: recompute what the expected total SHOULD be right now, substituting
 * the CURRENT active fabric rate into the same cost structure (same CMTP, same
 * REJ/OH/margin), and validate the vendor's submission against THAT live figure.
 *
 * Worked example from the spec: standard was ₹210 at grey ₹70; grey is now ₹85,
 * so the expected fabric component rises ₹15 → expected ≈ ₹225. A vendor at ₹226
 * is a ₹1 CM/labour deviation (the real flag) — the ₹15 grey move is expected and
 * never flags on its own.
 *
 * §5 rule (unchanged): the commodity/fabric side is INFORMATIONAL ("grey +X%
 * since last PO, remark optional"); only a genuine CM/labour deviation
 * hard-blocks (with a mandatory remark). The recompute makes the fabric side
 * comparable to the live rate so it stops masquerading as a CM discrepancy.
 */

/** FINAL PRICE build constants (STANDARD-COST-SPEC §4b). REJ/OH cap at ₹10. */
export const FINAL_PRICE = {
  rejPct: 0.05,
  rejCap: 10,
  ohPct: 0.05,
  ohCap: 10,
  marginPct: 0.15, // flat 15% on the subtotal after REJ + OH (spec assumption)
};

export type FinalPriceBreakdown = {
  fabric: number;
  cmtp: number;
  garment: number; // fabric + CMTP
  rej: number;
  oh: number;
  margin: number;
  final: number;
};

const r2 = (n: number) => Math.round(n * 100) / 100;

/**
 * Garment (Fabric + CMTP) → REJ (min 5%/₹10) → OH (min 5%/₹10) → MARGIN 15%
 * → FINAL PRICE. Mirrors the Final Cost tab so recompute == displayed standard.
 */
export function finalPrice(
  fabric: number,
  cmtp: number,
  k = FINAL_PRICE,
): FinalPriceBreakdown {
  const garment = fabric + cmtp;
  const rej = Math.min(garment * k.rejPct, k.rejCap);
  const oh = Math.min(garment * k.ohPct, k.ohCap);
  const margin = (garment + rej + oh) * k.marginPct;
  return {
    fabric: r2(fabric),
    cmtp: r2(cmtp),
    garment: r2(garment),
    rej: r2(rej),
    oh: r2(oh),
    margin: r2(margin),
    final: r2(garment + rej + oh + margin),
  };
}

export type RecomputeInput = {
  /** Per-size (or PO-average) fabric consumption in metres. */
  consumption: number;
  /** The CURRENT active finished-fabric rate (₹/m) — grey→processing buildup,
   *  or the monthly EFOB rate for EFOB POs. Substituted for the fabric side. */
  fabricRateNow: number;
  /** CMTP total held constant from the approved standard. */
  cmtp: number;
  /** The fabric rate baked into the standard when it was approved (for the
   *  informational "rate moved ₹X" delta). Optional. */
  fabricRateAtStd?: number | null;
};

export type RecomputeResult = {
  fabricRateNow: number;
  fabricRateAtStd: number | null;
  /** Live-adjusted fabric component = rateNow × consumption. */
  expectedFabric: number;
  /** The full live-adjusted expected FINAL price. */
  expected: FinalPriceBreakdown;
  /** Fabric-rate movement since the standard (₹/m and %); null if no baseline. */
  rateDelta: number | null;
  rateDeltaPct: number | null;
};

/**
 * recomputeExpectedCost — the live expected FINAL price for a product, with the
 * current fabric rate substituted in and CMTP + REJ/OH/margin held constant.
 * Pure: the caller supplies the current rate (from sd_fabric_cost_base or the
 * monthly sd_efob_fabric_cost) so this stays testable and rate-source-agnostic.
 */
export function recomputeExpectedCost(input: RecomputeInput, k = FINAL_PRICE): RecomputeResult {
  const expectedFabric = input.fabricRateNow * input.consumption;
  const expected = finalPrice(expectedFabric, input.cmtp, k);
  const base = input.fabricRateAtStd ?? null;
  return {
    fabricRateNow: r2(input.fabricRateNow),
    fabricRateAtStd: base,
    expectedFabric: r2(expectedFabric),
    expected,
    rateDelta: base == null ? null : r2(input.fabricRateNow - base),
    rateDeltaPct: base == null || base === 0 ? null : r2(((input.fabricRateNow - base) / base) * 100),
  };
}

export type CostVerdict = {
  /** Vendor's submitted total vs the live-recomputed expected. */
  submitted: number;
  expected: number;
  gap: number; // submitted − expected (the residual CM/labour deviation)
  /** The isolated CM deviation: submitted CM vs standard CM. */
  cmSubmitted: number;
  cmStandard: number;
  cmGap: number;
  /** Hard-block only when CM deviates beyond tolerance (§5); fabric moves never
   *  hard-block on their own. */
  hardBlock: boolean;
  /** Informational: the fabric rate moved since the standard. */
  fabricInfo: { rateDelta: number | null; rateDeltaPct: number | null };
};

/**
 * Validate a vendor submission. CM tolerance defaults to ₹0.005 (rounding).
 * hardBlock is CM-only — a fabric/commodity move is surfaced but never blocks.
 */
export function validateSubmittedCost(args: {
  submittedTotal: number;
  cmSubmitted: number;
  cmStandard: number;
  recompute: RecomputeResult;
  cmTolerance?: number;
}): CostVerdict {
  const tol = args.cmTolerance ?? 0.005;
  const cmGap = args.cmSubmitted - args.cmStandard;
  return {
    submitted: r2(args.submittedTotal),
    expected: args.recompute.expected.final,
    gap: r2(args.submittedTotal - args.recompute.expected.final),
    cmSubmitted: r2(args.cmSubmitted),
    cmStandard: r2(args.cmStandard),
    cmGap: r2(cmGap),
    hardBlock: cmGap > tol,
    fabricInfo: {
      rateDelta: args.recompute.rateDelta,
      rateDeltaPct: args.recompute.rateDeltaPct,
    },
  };
}
