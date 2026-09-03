import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  finalPrice,
  recomputeExpectedCost,
  validateSubmittedCost,
} from './standard-cost';

test('finalPrice: REJ/OH cap at ₹10, margin 15% after REJ+OH', () => {
  // Garment 220 → 5% = 11 > cap → REJ = OH = 10; margin = 15% of 240 = 36.
  const b = finalPrice(120, 100);
  assert.equal(b.garment, 220);
  assert.equal(b.rej, 10);
  assert.equal(b.oh, 10);
  assert.equal(b.margin, 36);
  assert.equal(b.final, 276);
  // Small garment: 5% below the ₹10 cap applies as a percentage.
  const s = finalPrice(50, 50); // garment 100 → REJ = OH = 5; margin = 15% of 110 = 16.5
  assert.equal(s.rej, 5);
  assert.equal(s.oh, 5);
  assert.equal(s.final, 126.5); // 100 + 5 + 5 + 16.5
});

test('recomputeExpectedCost: substitutes the current fabric rate, holds CMTP', () => {
  // Spec worked example, expressed in the real structure: consumption 1m so the
  // fabric component == the rate. Grey/finished 70 → 85, CMTP 100.
  const atStd = recomputeExpectedCost({ consumption: 1, fabricRateNow: 70, cmtp: 100 });
  const now = recomputeExpectedCost({ consumption: 1, fabricRateNow: 85, cmtp: 100, fabricRateAtStd: 70 });
  // Fabric side rises by exactly the ₹15 rate move.
  assert.equal(now.expectedFabric - atStd.expectedFabric, 15);
  assert.equal(now.rateDelta, 15);
  // The whole expected total shifts up (garment +15 flows through REJ/OH/margin).
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
