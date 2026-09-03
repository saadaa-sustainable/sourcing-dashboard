import { test } from 'node:test';
import assert from 'node:assert/strict';
import { computeApprovalContext, isOngoing, type ContextSku } from './approval-context';

const sku = (color: string, size: string, state: string, stock: number): ContextSku => ({
  color,
  size,
  productStatus: state,
  currentStock: stock,
});

test('exclusion: NPD-family and discontinued are not ongoing', () => {
  assert.equal(isOngoing('Ongoing'), true);
  assert.equal(isOngoing('NPD'), false);
  assert.equal(isOngoing('NPD - Not Launched Yet'), false);
  assert.equal(isOngoing('To Be Discontinued'), false);
  assert.equal(isOngoing('Discontinued'), false);
});

test('SKU in-stock rate excludes NPD/discontinued from both sides', () => {
  const skus = [
    sku('Red', 'S', 'Ongoing', 5), // in stock
    sku('Red', 'M', 'Ongoing', 0), // ongoing, out
    sku('Blue', 'S', 'Ongoing', 3), // in stock
    sku('Blue', 'M', 'NPD', 9), // excluded even though it has stock
    sku('Green', 'S', 'Discontinued', 9), // excluded
  ];
  const ctx = computeApprovalContext(skus, { ipdoq: 2, currentStock: 8, inProcess: 4 });
  // ongoing = 3 (Red S/M, Blue S); in stock = 2 → 0.67
  assert.equal(ctx.ongoingSkuCount, 3);
  assert.equal(ctx.skuInStockRate, 0.67);
  // DOH = (8 + 4) / 2 = 6
  assert.equal(ctx.doh, 6);
});

test('Color In-Stock Rate: two-layer, 75% threshold (spec 14/20 = 0.70)', () => {
  // 20 colours: 14 with all sizes in stock (100% ≥ 75%), 6 with 0% → 14/20.
  const skus: ContextSku[] = [];
  for (let i = 0; i < 20; i++) {
    const color = `C${i}`;
    const inStock = i < 14; // first 14 colours fully stocked
    skus.push(sku(color, 'S', 'Ongoing', inStock ? 5 : 0));
    skus.push(sku(color, 'M', 'Ongoing', inStock ? 5 : 0));
  }
  const ctx = computeApprovalContext(skus, { ipdoq: 1, currentStock: 0, inProcess: 0 });
  assert.equal(ctx.totalColors, 20);
  assert.equal(ctx.qualifyingColors, 14);
  assert.equal(ctx.colorInStockRate, 0.7);
});

test('Color threshold is applied at the size level (5 of 6 sizes = 83% qualifies)', () => {
  const skus: ContextSku[] = [];
  // One colour, 6 sizes, 5 in stock → 0.833 ≥ 0.75 → qualifies.
  ['XS', 'S', 'M', 'L', 'XL', '2XL'].forEach((sz, i) => skus.push(sku('Red', sz, 'Ongoing', i < 5 ? 4 : 0)));
  const ctx = computeApprovalContext(skus, { ipdoq: 1, currentStock: 0, inProcess: 0 });
  assert.equal(ctx.qualifyingColors, 1);
  assert.equal(ctx.colorInStockRate, 1);
  // Same colour but only 4 of 6 (67% < 75%) → does not qualify.
  const skus2 = skus.map((s, idx) => (idx === 4 ? { ...s, currentStock: 0 } : s));
  const ctx2 = computeApprovalContext(skus2, { ipdoq: 1, currentStock: 0, inProcess: 0 });
  assert.equal(ctx2.qualifyingColors, 0);
  assert.equal(ctx2.colorInStockRate, 0);
});
