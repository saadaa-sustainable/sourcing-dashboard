import assert from 'node:assert/strict';
import { test } from 'node:test';
import { materialItemCodes, type MaterialItem } from './material-item-codes';

const item = (sku: string, values: Partial<MaterialItem> = {}): MaterialItem => ({
  sku, product_name: null, item_category: null, category_name: null, colour: null, rm_fabric_sku: null, ...values,
});

test('EasyEcom raw, finished and trim SKUs carry their names and automatic colours', () => {
  assert.deepEqual(materialItemCodes([
    item(' CSL/50/RM ', { item_category: ' Greige ', colour: ' GREIGE ' }),
    item('CSL/50/BL', { item_category: 'Finished', colour: 'BLACK', product_name: 'Cotton Satin Lycra', rm_fabric_sku: 'CSL/50/RM' }),
    item('SDSL-4XL', { category_name: 'SIZE LABEL', colour: 'GREIGE' }),
  ]).map((code) => [code.material_code, code.material_type, code.colour]), [
    ['CSL/50/BL', 'dyed', 'BLACK'], ['CSL/50/RM', 'raw', 'GREIGE'], ['SDSL-4XL', 'trim', 'GREIGE'],
  ]);
});

test('garments and unclassified items never fall into trims', () => {
  assert.equal(materialItemCodes([
    item('WCFLKBL-CPWH_2XL', { category_name: 'WC' }),
    item('SHIRT', { item_category: 'CASUAL', category_name: 'SDLS' }),
    item('UNKNOWN', { category_name: 'Unknown' }),
    item(' ', { item_category: 'Greige' }),
  ]).length, 0);
});

test('actual EasyEcom label and packaging categories populate trims', () => {
  const categories = ['SIZE LABEL', 'VENDOR LABEL', 'WASHCARE LABEL', 'THERMAL LABEL', 'SEED TAGS',
    'BUTTER PAPPER', 'CELLO TAPE', 'CHITTHI', 'FABRIC BAG', 'POLY BAG'];
  assert.equal(materialItemCodes(categories.map((category_name) => item(category_name, { category_name })))
    .filter((code) => code.material_type === 'trim').length, categories.length);
});

test('material codes beyond the thousandth item remain available', () => {
  const items = Array.from({ length: 1501 }, (_, i) => item(`SKU-${i}`, { category_name: 'TRIMS' }));
  assert.equal(materialItemCodes(items).length, 1501);
  assert.ok(materialItemCodes(items).some((code) => code.material_code === 'SKU-1500'));
});

test('normalizes duplicates, preserves missing metadata and refuses conflicting classifications', () => {
  const raw = item('ABC', { item_category: 'RAW MATERIAL' });
  assert.deepEqual(materialItemCodes([raw, raw]), [{ material_code: 'ABC', material_type: 'raw',
    fabric_name: 'ABC', colour: null, base_fabric_code: null }]);
  assert.throws(() => materialItemCodes([raw, item('abc', { category_name: 'TRIM' })]), /Conflicting/);
});
