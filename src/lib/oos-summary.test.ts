import assert from 'node:assert/strict';
import { test } from 'node:test';
import { isSellingState, normaliseCategory, summariseOos } from './oos-summary';

const sku = (o: Partial<Parameters<typeof summariseOos>[0][number]> & { sku: string }) => ({
  category: 'SDFLK',
  name: 'Airy Linen Long Kurta',
  stock: 10,
  dailyDemand: 1,
  oosDays45: 0,
  oosDays365: 0,
  ...o,
});

test('selling states: Ongoing and launched NPD only', () => {
  assert.equal(isSellingState('Ongoing'), true);
  assert.equal(isSellingState('NPD'), true);
  assert.equal(isSellingState('NPD - Not Launched Yet'), false);
  assert.equal(isSellingState('Discontinued'), false);
  assert.equal(isSellingState('To Be Discontinued'), false);
  assert.equal(isSellingState(null), false);
});

test('category is the product code, upper-cased and trimmed', () => {
  assert.equal(normaliseCategory('sdflk'), 'SDFLK');
  assert.equal(normaliseCategory(' SMFSK '), 'SMFSK');
  assert.equal(normaliseCategory(''), 'UNCATEGORISED');
});

test('the two OOS measures, the shared-basis percentages and the change', () => {
  // 10 SKUs. Four were empty at some point in 45 days; one of those is still empty.
  const rows = [
    sku({ sku: 'a', stock: 0, oosDays45: 45, oosDays365: 200 }),   // empty all window, still empty
    sku({ sku: 'b', stock: 5, oosDays45: 10, oosDays365: 10 }),    // recovered
    sku({ sku: 'c', stock: 5, oosDays45: 20, oosDays365: 20 }),    // recovered
    sku({ sku: 'd', stock: 5, oosDays45: 15, oosDays365: 15 }),    // recovered
    ...['e', 'f', 'g', 'h', 'i', 'j'].map((s) => sku({ sku: s })),
  ];
  const { all } = summariseOos(rows);
  assert.equal(all.skus, 10);
  assert.equal(all.oosYesterday, 1);
  assert.equal(all.oos45, 4);
  assert.equal(all.oos365, 4);
  assert.equal(all.recovered45, 3);
  assert.equal(all.oosDays45, 90);
  // 90 empty SKU-days over 10 × 45 = 450 → 20%; yesterday 1 of 10 → 10%; a 50% fall.
  assert.equal(all.pct45, 0.2);
  assert.equal(all.pctYesterday, 0.1);
  assert.equal(all.changeVs45, -0.5);
  assert.equal(all.pct365, 245 / 3650);
});

test('days on hand uses only SKUs that sell', () => {
  const rows = [
    sku({ sku: 'a', stock: 100, dailyDemand: 0 }), // dead stock must not inflate cover
    sku({ sku: 'b', stock: 30, dailyDemand: 2 }),
    sku({ sku: 'c', stock: 10, dailyDemand: 2 }),
  ];
  assert.equal(summariseOos(rows).all.daysOnHand, 10);
  assert.equal(summariseOos([sku({ sku: 'a', dailyDemand: 0 })]).all.daysOnHand, null);
});

test('no change when there was nothing to fall from', () => {
  assert.equal(summariseOos([sku({ sku: 'a' })]).all.changeVs45, null);
  assert.equal(summariseOos([]).all.pct45, 0);
});

test('categories are folded, named, and ordered worst-yesterday first', () => {
  const rows = [
    sku({ sku: 'a', category: 'SDFLK', stock: 0, oosDays45: 1 }),
    sku({ sku: 'b', category: 'sdflk' }),
    sku({ sku: 'c', category: 'SDCP', name: 'Casual Pant' }),
  ];
  const { categories } = summariseOos(rows);
  assert.deepEqual(categories.map((c) => c.scope), ['SDFLK', 'SDCP']);
  assert.equal(categories[0].label, 'Airy Linen Long Kurta');
  assert.equal(categories[1].label, 'Casual Pant');
  assert.equal(categories[0].skus, 2);
  assert.equal(categories[0].pctYesterday, 0.5);
});

test('the SKUs behind a category: empty first, then recovered by days empty, then the rest', () => {
  const rows = [
    sku({ sku: 'ok', stock: 5 }),
    sku({ sku: 'rec-short', stock: 5, oosDays45: 3 }),
    sku({ sku: 'empty', stock: 0, oosDays45: 12 }),
    sku({ sku: 'rec-long', stock: 5, oosDays45: 20 }),
  ];
  const { skusByScope } = summariseOos(rows);
  assert.deepEqual(skusByScope.SDFLK.map((r) => r.sku), ['empty', 'rec-long', 'rec-short', 'ok']);
  assert.deepEqual(skusByScope.SDFLK.map((r) => r.state), ['empty', 'recovered', 'recovered', 'ok']);
});
