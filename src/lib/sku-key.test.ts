import { test } from 'node:test';
import assert from 'node:assert/strict';
import { skuKey } from './sku-key';

test('the master spelling and the feed spelling of one SKU share a key', () => {
  assert.equal(skuKey('SDCPBL_S'), skuKey('SDCPBLS'));
  assert.equal(skuKey('sdfakbl_3xl'), 'SDFAKBL3XL');
  assert.equal(skuKey(' SDRPTBR_L '), 'SDRPTBRL');
});

test('punctuation never separates two SKUs; a blank stays blank', () => {
  assert.equal(skuKey('20CF/63/RM'), '20CF63RM');
  assert.equal(skuKey(''), '');
  assert.equal(skuKey(null), '');
  assert.equal(skuKey(undefined), '');
});
