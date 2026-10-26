import assert from 'node:assert/strict';
import test from 'node:test';
import { easyEcomCostProducts, finishedGoodsCostStatus, finishedGoodsCostUpdatedAt, hasApprovedProductCost } from './finished-goods-cost';
import type { StandardCost, StandardCostRateHistory } from './forms/types';

test('SKU master produces one cost row per product and excludes catalog-only typed products', () => {
  const products = easyEcomCostProducts([
    {sku:'SHIRTBL_S',product_variant:'SHIRTBL',product_name:'Blue shirt'},
    {sku:'SHIRTBL_M',product_variant:'SHIRTBL',product_name:'Blue shirt'},
    {sku:'SHIRTWH_L',product_variant:'SHIRTWH',product_name:'White shirt'},
  ],[{product_code:'SHIRT',product_name:'Shirt'},{product_code:'TYPED',product_name:'Manually typed'}]);
  assert.equal(products.length,1);
  assert.equal(products[0].code,'SHIRT');
  assert.equal(products[0].skus.length,3);
  assert.equal(products[0].name,'Shirt');
});
test('missing variant uses the most specific known SKU prefix and never invents an unknown product', () => {
  const products=easyEcomCostProducts([
    {sku:'ABCD_S',product_variant:null,product_name:'Known'},
    {sku:'UNKNOWN_S',product_variant:null,product_name:'Unknown'},
  ],[{product_code:'AB',product_name:null},{product_code:'ABCD',product_name:null}]);
  assert.deepEqual(products.map(p=>p.code),['ABCD']);
});
test('blank and pending cost shells offer Add; an approved baseline or accepted history offers Amend/Update', () => {
  const cost={status:'draft',neg_stage:null} as StandardCost;
  assert.equal(hasApprovedProductCost(undefined),false);
  assert.equal(hasApprovedProductCost(cost),false);
  assert.equal(hasApprovedProductCost({...cost,status:'pending_l2'}),false);
  assert.equal(hasApprovedProductCost({...cost,status:'approved'}),true);
  assert.equal(hasApprovedProductCost({...cost,neg_stage:'signed_off'}),true);
  assert.equal(hasApprovedProductCost(undefined,[{id:1} as StandardCostRateHistory]),true);
});
test('table status follows the open revision while the approved baseline stays available', () => {
  const cost={status:'approved',neg_stage:'signed_off'} as StandardCost;
  const pending={id:1,product_code:'A',status:'pending' as const,approved_sections:[]};
  assert.equal(finishedGoodsCostStatus(cost,[],pending),'Approval Pending');
  assert.equal(finishedGoodsCostStatus(cost,[],{...pending,approved_sections:['cmtp']}),'Partially Approved');
  assert.equal(finishedGoodsCostStatus(cost,[],{...pending,status:'rework'}),'Rework / Reassign');
  assert.equal(finishedGoodsCostStatus(cost,[]),'Approved');
  assert.equal(finishedGoodsCostStatus({status:'draft',documented:false} as StandardCost,[]),'Not added');
});
test('cost updated date uses latest approval, including section approvals, and ignores operational updates', () => {
  const cost={approved_at:'2026-10-25T12:00:00Z',updated_at:'2026-10-26T12:00:00Z'} as StandardCost;
  assert.equal(finishedGoodsCostUpdatedAt(cost,[{accepted_at:'2026-10-24T12:00:00Z'} as StandardCostRateHistory]),cost.approved_at);
  assert.equal(finishedGoodsCostUpdatedAt({...cost,approved_at:null},[{accepted_at:'2026-10-24T12:00:00Z'} as StandardCostRateHistory]),'2026-10-24T12:00:00Z');
  assert.equal(finishedGoodsCostUpdatedAt({updated_at:cost.updated_at} as StandardCost,[]),null);
});
