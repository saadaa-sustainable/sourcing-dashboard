import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  ageingBucket,
  deriveVariant,
  recommendedAction,
  rollupBySku,
  suggestedDiscount,
  type DiscontinuedInventoryRow,
} from './discontinued';

const unit = (over: Partial<DiscontinuedInventoryRow>): DiscontinuedInventoryRow => ({
  source_row_key: Math.random().toString(36),
  sku: 'SDALPNB_4XL',
  category: 'SDALP',
  sub_category: 'Casual Pant',
  product_name: 'AIRY LINEN PANT',
  color: 'NAVY BLUE',
  size: '4XL',
  mrp: 2399,
  cost: 600,
  product_launch_date: '2024-04-01',
  product_state: 'Discontinued',
  available_inventory: 1,
  inventory_status: 'Inventory Available',
  status: 'Available',
  serial_number: 'sd-1',
  inward_date: '2024-04-01',
  days_in_warehouse: 400,
  ...over,
});

describe('discontinued inventory rules', () => {
  it('derives product_variant and product_code from a SKU', () => {
    assert.deepEqual(deriveVariant('SDALPNB_4XL'), { productVariant: 'SDALPNB', productCode: 'SDALP' });
    assert.deepEqual(deriveVariant('SDALPTU_S'), { productVariant: 'SDALPTU', productCode: 'SDALP' });
    assert.deepEqual(deriveVariant(''), { productVariant: '', productCode: '' });
  });

  it('buckets ageing at the 90 / 180 / 365 boundaries', () => {
    assert.equal(ageingBucket(0), 'New');
    assert.equal(ageingBucket(89), 'New');
    assert.equal(ageingBucket(90), 'Aging');
    assert.equal(ageingBucket(180), 'Aging');
    assert.equal(ageingBucket(181), 'Old');
    assert.equal(ageingBucket(365), 'Old');
    assert.equal(ageingBucket(366), 'Dead Stock');
  });

  it('suggests discounts on the finer 90/180/270/365 bands', () => {
    assert.equal(suggestedDiscount(50), '—');
    assert.equal(suggestedDiscount(120), '10%');
    assert.equal(suggestedDiscount(200), '20%');
    assert.equal(suggestedDiscount(300), '30%');
    assert.equal(suggestedDiscount(500), '40–60%');
  });

  it('applies the recommended-action precedence', () => {
    // qty bands
    assert.equal(recommendedAction({ qty: 5, oldestDays: 100, sales45d: 3 }), 'Sell through naturally');
    assert.equal(recommendedAction({ qty: 25, oldestDays: 100, sales45d: 3 }), 'Transfer to high-selling store');
    assert.equal(recommendedAction({ qty: 80, oldestDays: 100, sales45d: 3 }), 'Run discount campaign');
    // >200 & >365 overrides the discount-campaign band
    assert.equal(recommendedAction({ qty: 250, oldestDays: 400, sales45d: 3 }), 'Bulk liquidation / B2B sale');
    // no sales & >365 wins over everything
    assert.equal(recommendedAction({ qty: 250, oldestDays: 400, sales45d: 0 }), 'Write-off review');
    // null sales is NOT "no sales"
    assert.equal(recommendedAction({ qty: 250, oldestDays: 400, sales45d: null }), 'Bulk liquidation / B2B sale');
  });

  it('rolls units up to SKU: qty, oldest ageing, value, and skips no-inventory rows', () => {
    const rows = [
      unit({ serial_number: 'a', days_in_warehouse: 120 }),
      unit({ serial_number: 'b', days_in_warehouse: 400 }),
      // No-inventory row for the same style must be ignored.
      unit({ serial_number: null, sku: 'SDALPNB_XS', inventory_status: 'No Inventory', available_inventory: 0, days_in_warehouse: null }),
    ];
    const sales = new Map([['SDALPNB', 7]]);
    const [rollup, ...rest] = rollupBySku(rows, sales);
    assert.equal(rest.length, 0); // only the available SKU survives
    assert.equal(rollup.sku, 'SDALPNB_4XL');
    assert.equal(rollup.qty, 2);
    assert.equal(rollup.oldestDays, 400); // oldest unit drives the SKU bucket / action
    assert.equal(rollup.bucket, 'Dead Stock');
    // Unit-level ageing: the 120-day unit stays Aging, only the 400-day one is Dead.
    assert.deepEqual(rollup.unitsByBucket, { New: 0, Aging: 1, Old: 0, 'Dead Stock': 1 });
    assert.equal(rollup.suggestedDiscount, '40–60%');
    assert.equal(rollup.sales45d, 7);
    assert.equal(rollup.action, 'Sell through naturally'); // qty 2 (<10)
    assert.equal(rollup.valueAtCost, 1200);
    assert.equal(rollup.valueAtMrp, 4798);
  });
});
