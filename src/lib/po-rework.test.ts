import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parsePoReworkSections, awaitingTnaReworkSave, scopedPoRework, canEditPoSection, poReworkFieldAllowed, poReworkLabel } from './po-rework';

test('valid selections are canonical and invalid/empty payloads are rejected', () => {
  for (const input of [null, [], 'cost', ['other'], ['cost', null]]) assert.equal(parsePoReworkSections(input), null);
  assert.deepEqual(parsePoReworkSections(['sku', 'cost', 'cost']), ['cost', 'sku']);
  assert.equal(poReworkLabel(['sku', 'tna']), 'TNA, SKU quantities');
});
test('legacy rework and other statuses preserve normal editing', () => {
  assert.equal(scopedPoRework({status:'rework'}), null);
  for (const status of ['draft', 'submitted', 'pending_l2', 'rejected', 'approved']) {
    assert.equal(scopedPoRework({status, rework_sections:['cost']}), null);
  }
});
test('every non-empty combination unlocks exactly its selected sections', () => {
  const keys = ['cost', 'tna', 'sku'] as const;
  for (let mask = 1; mask < 8; mask++) {
    const selected = keys.filter((_, index) => mask & (1 << index));
    const po = {status:'rework', rework_sections:selected};
    for (const key of keys) assert.equal(canEditPoSection(po, key), selected.includes(key));
    assert.equal(poReworkFieldAllowed('rate', selected), selected.includes('cost'));
    assert.equal(poReworkFieldAllowed('tna_days_first_delivery', selected), selected.includes('tna'));
    for (const field of ['vendor_code', 'product_code', 'buying_plan_no', 'po_qty', 'status', 'rework_sections']) {
      assert.equal(poReworkFieldAllowed(field, selected), false);
    }
  }
});

test('TNA rework submission waits for a save in the current rework round', () => {
  const po = {status:'rework', rework_sections:['tna'], tna_rework_saved_at: null as string | null, reworked_at:'2026-10-23T10:00:00Z'};
  assert.equal(awaitingTnaReworkSave(po), true);
  assert.equal(awaitingTnaReworkSave({...po,tna_rework_saved_at:'2026-10-23T09:00:00Z'}),true);
  assert.equal(awaitingTnaReworkSave({...po,tna_rework_saved_at:'2026-10-23T11:00:00Z'}),false);
  assert.equal(awaitingTnaReworkSave({...po,rework_sections:['cost']}),false);
  assert.equal(awaitingTnaReworkSave({...po,status:'submitted'}),false);
});

test('legacy schema keeps TNA saves and submission available before migration', () => {
  assert.equal(awaitingTnaReworkSave({status:'rework',rework_sections:['tna']}),false);
});
