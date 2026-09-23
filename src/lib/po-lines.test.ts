import assert from 'node:assert/strict';
import { test } from 'node:test';
import { checkLines, distributeQty, fromMatrix, mergeLines, parsePastedLines, skuOf, toQty } from './po-lines';

test('quantities: commas, rupees, spaces and rubbish', () => {
  assert.equal(toQty('2,400'), 2400);
  assert.equal(toQty(' ₹ 1200 '), 1200);
  assert.equal(toQty('300.0'), 300);
  assert.equal(toQty(''), null);
  assert.equal(toQty('abc'), null);
  assert.equal(toQty('12 pcs'), null);
});

test('paste a list with a header, in any column order', () => {
  const r = parsePastedLines('Qty\tSize\tColour\n120\tM\tSDFLKCB\n80\tL\tSDFLKCB\n');
  assert.equal(r.shape, 'list');
  assert.deepEqual(r.columns, { variant: 2, size: 1, qty: 0 });
  assert.deepEqual(r.rows, [
    { product_variant: 'SDFLKCB', size: 'M', qty: 120 },
    { product_variant: 'SDFLKCB', size: 'L', qty: 80 },
  ]);
  assert.equal(r.issues.length, 0);
});

test('paste a list with no header — colour, size, qty in order', () => {
  const r = parsePastedLines('SDFLKCB,M,120\nSDFLKCB,L,80');
  assert.equal(r.shape, 'list');
  assert.equal(r.rows.length, 2);
  assert.equal(r.rows[1].qty, 80);
});

test('paste a matrix — sizes across the top, colours down the side', () => {
  const r = parsePastedLines(['Colour\tS\tM\tL\tXL', 'SDFLKCB\t10\t20\t30\t', 'SDFLKLI\t\t5\t\t15'].join('\n'));
  assert.equal(r.shape, 'matrix');
  assert.deepEqual(r.rows, [
    { product_variant: 'SDFLKCB', size: 'S', qty: 10 },
    { product_variant: 'SDFLKCB', size: 'M', qty: 20 },
    { product_variant: 'SDFLKCB', size: 'L', qty: 30 },
    { product_variant: 'SDFLKLI', size: 'M', qty: 5 },
    { product_variant: 'SDFLKLI', size: 'XL', qty: 15 },
  ]);
  assert.equal(r.issues.length, 0);
});

test('nothing is dropped silently: bad cells come back as issues', () => {
  const r = parsePastedLines('Colour\tSize\tQty\nSDFLKCB\tM\tabc\n\tL\t20\nSDFLKCB\tS\t15');
  assert.deepEqual(r.rows, [{ product_variant: 'SDFLKCB', size: 'S', qty: 15 }]);
  assert.deepEqual(r.issues.map((i) => i.reason), ['quantity is not a number', 'no colour / variant']);
  assert.deepEqual(r.issues.map((i) => i.row), [2, 3]);
});

test('the same colour and size twice adds up', () => {
  assert.deepEqual(
    mergeLines([
      { product_variant: 'A', size: 'M', qty: 10 },
      { product_variant: 'A', size: 'M', qty: 5 },
      { product_variant: 'A', size: 'L', qty: 7 },
    ]),
    [
      { product_variant: 'A', size: 'M', qty: 15 },
      { product_variant: 'A', size: 'L', qty: 7 },
    ],
  );
});

test('matrix grid → lines drops blanks and zeroes, upper-cases keys', () => {
  assert.deepEqual(fromMatrix({ sdflkcb: { m: '12', l: '', s: '0' }, SDFLKLI: { M: '3' } }), [
    { product_variant: 'SDFLKCB', size: 'M', qty: 12 },
    { product_variant: 'SDFLKLI', size: 'M', qty: 3 },
  ]);
});

test('SKU key matches the feed: variant_size, upper-cased', () => {
  assert.equal(skuOf('sdflkcb', 'm'), 'SDFLKCB_M');
  assert.equal(skuOf('SDFLKCB', ''), 'SDFLKCB');
});

test('lines are matched against pending quantity per SKU', () => {
  const rows = [
    { product_variant: 'SDFLKCB', size: 'M', qty: 200 },
    { product_variant: 'SDFLKCB', size: 'L', qty: 50 },
    { product_variant: 'SDFLKZZ', size: 'M', qty: 10 },
  ];
  const pending = [
    { sku: 'SDFLKCB_M', product_variant: 'SDFLKCB', size: 'M', pendingQty: 100 },
    { sku: 'SDFLKCB_L', product_variant: 'SDFLKCB', size: 'L', pendingQty: 80 },
  ];
  const { checks, totalQty, totalPending, over } = checkLines(rows, pending, ['SDFLKCB']);
  assert.equal(totalQty, 260);
  assert.equal(totalPending, 180);
  assert.equal(over, 1); // only the M line orders more than is outstanding
  assert.equal(checks[0].delta, 100);
  assert.equal(checks[1].delta, -30);
  assert.equal(checks[2].pendingQty, 0);
  assert.equal(checks[2].unknownVariant, true);
  assert.equal(checks[0].unknownVariant, false);
});

test('a plan quantity splits across SKUs without losing or inventing pieces', () => {
  // Weighted by the mix this product was bought in before: 50 / 30 / 20 of 1000.
  const mix = [
    { product_variant: 'SDFLKCB', size: 'M', weight: 500 },
    { product_variant: 'SDFLKCB', size: 'L', weight: 300 },
    { product_variant: 'SDFLKLI', size: 'M', weight: 200 },
  ];
  const rows = distributeQty(1000, mix);
  assert.deepEqual(rows.map((r) => r.qty), [500, 300, 200]);
  assert.equal(rows.reduce((s, r) => s + r.qty, 0), 1000);

  // An awkward total still adds up exactly - the remainder goes to the largest fractions.
  const odd = distributeQty(1001, mix);
  assert.equal(odd.reduce((s, r) => s + r.qty, 0), 1001);

  // No history: an even split, and the remainder is handed out one piece at a time.
  const even = distributeQty(10, [
    { product_variant: 'A', size: 'S', weight: 0 },
    { product_variant: 'A', size: 'M', weight: 0 },
    { product_variant: 'A', size: 'L', weight: 0 },
  ]);
  assert.deepEqual(even.map((r) => r.qty), [4, 3, 3]);
  assert.equal(even.reduce((s, r) => s + r.qty, 0), 10);

  // Nothing to suggest.
  assert.deepEqual(distributeQty(0, mix), []);
  assert.deepEqual(distributeQty(500, []), []);
  // Cells that round to nothing are left out rather than saved as zero rows.
  assert.equal(distributeQty(2, mix).length, 2);
});
