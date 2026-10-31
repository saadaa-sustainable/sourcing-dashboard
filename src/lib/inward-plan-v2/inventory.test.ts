import assert from 'node:assert/strict';
import { test } from 'node:test';
import { variantInventoryTotals } from './inventory';

const size = (sku: string, current_stock: number | null, doq_45: number | null) => ({ sku, size: sku, current_stock, doq_45 });

test('variant DOQ sums sizes and DOH uses pooled stock/demand, not a sum or average of size DOH', () => {
  assert.deepEqual(variantInventoryTotals([size('S', 24, 3), size('M', 6, 2)]), { doq: 5, doh: 6 });
});
test('missing stock preserves known demand but makes DOH unavailable', () => {
  assert.deepEqual(variantInventoryTotals([size('S', null, 3), size('M', 6, 2)]), { doq: 5, doh: null });
});
test('missing demand does not manufacture partial variant demand or DOH', () => {
  assert.deepEqual(variantInventoryTotals([size('S', 24, null), size('M', 6, 2)]), { doq: null, doh: null });
});
test('zero stock is known and zero demand has unavailable DOH', () => {
  assert.deepEqual(variantInventoryTotals([size('S', 0, 3)]), { doq: 3, doh: 0 });
  assert.deepEqual(variantInventoryTotals([size('S', 24, 0)]), { doq: 0, doh: null });
});
test('empty and nonfinite source values remain unavailable', () => {
  assert.deepEqual(variantInventoryTotals([]), { doq: null, doh: null });
  assert.deepEqual(variantInventoryTotals([size('S', Infinity, NaN)]), { doq: null, doh: null });
});
