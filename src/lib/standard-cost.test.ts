import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  finalPrice,
  recomputeExpectedCost,
  validateSubmittedCost,
} from './standard-cost';

test('finalPrice: final = garment + margin (REJ/OH removed 2026-09-08)', () => {
  // Garment 220 → margin 15% = 33 → final 253.
  const b = finalPrice(120, 100);
  assert.equal(b.garment, 220);
  assert.equal(b.margin, 33);
  assert.equal(b.final, 253);
  // Garment 100 → margin 15% = 15 → final 115.
  const s = finalPrice(50, 50);
  assert.equal(s.margin, 15);
  assert.equal(s.final, 115);
  // Margin is configurable (Rules Master): 20% on garment 100 → final 120.
  const custom = finalPrice(50, 50, { marginPct: 0.2 });
  assert.equal(custom.margin, 20);
  assert.equal(custom.final, 120);
});

test('recomputeExpectedCost: substitutes the current fabric rate, holds CMTP', () => {
  // Spec worked example, expressed in the real structure: consumption 1m so the
  // fabric component == the rate. Grey/finished 70 → 85, CMTP 100.
  const atStd = recomputeExpectedCost({ consumption: 1, fabricRateNow: 70, cmtp: 100 });
  const now = recomputeExpectedCost({ consumption: 1, fabricRateNow: 85, cmtp: 100, fabricRateAtStd: 70 });
  // Fabric side rises by exactly the ₹15 rate move.
  assert.equal(now.expectedFabric - atStd.expectedFabric, 15);
  assert.equal(now.rateDelta, 15);
  // The whole expected total shifts up (garment +15 flows through the margin).
  assert.ok(now.expected.final > atStd.expected.final);
});

test('validateSubmittedCost: grey move is informational, CM deviation hard-blocks', () => {
  const recompute = recomputeExpectedCost({ consumption: 1, fabricRateNow: 85, cmtp: 100, fabricRateAtStd: 70 });

  // Vendor matches the recomputed expectation (only the expected grey move) → no block.
  const ok = validateSubmittedCost({
    submittedTotal: recompute.expected.final,
    cmSubmitted: 100,
    cmStandard: 100,
    recompute,
  });
  assert.equal(ok.hardBlock, false);
  assert.equal(ok.fabricInfo.rateDelta, 15); // surfaced, not blocking

  // Vendor's CM is ₹1 above standard → the real discrepancy, hard-block.
  const bad = validateSubmittedCost({
    submittedTotal: recompute.expected.final + 1,
    cmSubmitted: 101,
    cmStandard: 100,
    recompute,
  });
  assert.equal(bad.hardBlock, true);
  assert.equal(bad.cmGap, 1);
});
