import assert from 'node:assert/strict';
import { test } from 'node:test';
import { materialDraftRows } from './material-plan-draft';

test('Save Draft includes the default row without requiring Add row first', () => {
  const row = { material_code: '60CT/48/RM', job_qty: '1', purchase_qty: '2', uom: 'metres', remark: 'Test', colour: 'GREIGE' };
  const result = materialDraftRows([], row);
  assert.deepEqual(result, [row]);
  assert.equal(result[0].remark, 'Test');
  assert.equal(result[0].uom, 'metres');
});
test('retains existing rows and excludes an untouched default row', () => {
  const rows = [{ material_code: 'A', job_qty: '3', purchase_qty: '0' }];
  assert.deepEqual(materialDraftRows(rows, null), rows);
  assert.deepEqual(materialDraftRows(rows, { material_code: 'B', job_qty: '', purchase_qty: '' }).map((r) => r.material_code), ['A', 'B']);
  assert.equal(rows.length, 1);
});
test('rejects duplicate codes and invalid default-row quantities before saving', () => {
  const row = { material_code: 'A', job_qty: '1', purchase_qty: '' };
  assert.throws(() => materialDraftRows([row], row), /already/);
  for (const job_qty of ['-1', 'Infinity', 'NaN']) {
    assert.throws(() => materialDraftRows([], { ...row, job_qty }), /quantities/);
  }
});
