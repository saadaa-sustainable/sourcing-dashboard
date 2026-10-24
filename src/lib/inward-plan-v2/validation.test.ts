import assert from 'node:assert/strict';
import { test } from 'node:test';
import { parseDraft, periodBounds, validDate, planTitle } from './validation';

function draft(overrides: Record<string, string> = {}) {
  const form = new FormData();
  for (const [key, value] of Object.entries({
    title: 'November receipts', period_kind: 'monthly', period_start: '2026-11-01',
    lines: JSON.stringify([{ po_detail_id: 'text-detail', expected_date: '2026-11-03',
      inward_qty: '2.5', cost_per_piece: '12.3400', remarks: '' }]), ...overrides,
  })) form.set(key, value);
  return form;
}
test('monthly cutoff is the midnight after the 2nd in IST', () => {
  assert.deepEqual(periodBounds('monthly', '2026-11-01'), {
    start: '2026-11-01', end: '2026-11-30', deadline: '2026-11-02T18:30:00.000Z',
  });
});
test('weekly cutoff is the midnight after Monday in IST and the period may cross months', () => {
  assert.deepEqual(periodBounds('weekly', '2026-11-30'), {
    start: '2026-11-30', end: '2026-12-06', deadline: '2026-11-30T18:30:00.000Z',
  });
});
test('calendar validation handles leap years and rejects normalized invalid dates', () => {
  assert.equal(validDate('2026-02-29'), false);
  assert.equal(validDate('2028-02-29'), true);
  assert.equal(periodBounds('monthly', '2028-02-01').end, '2028-02-29');
  assert.throws(() => periodBounds('weekly', '2026-11-01'), /Monday/);
  assert.throws(() => periodBounds('monthly', '2026-11-02'), /1st/);
});
test('empty drafts are valid and client-supplied source descriptions are discarded', () => {
  assert.equal(parseDraft(draft({ lines: '[]' })).lines.length, 0);
  const parsed = parseDraft(draft());
  assert.equal(parsed.lines[0].po_detail_id, 'text-detail');
  assert.equal(parsed.lines[0].label, '');
  assert.equal(parsed.lines[0].inward_qty, '2.5');
});
test('reject invalid IDs and malformed payloads', () => {
  assert.throws(() => parseDraft(draft({ id: '123' })), /ID/);
  assert.equal(parseDraft(draft({ title: '   ' })).header.title, 'IP_Monthly_Nov_2026');
  assert.throws(() => parseDraft(draft({ lines: '{}' })), /500 lines/);
  assert.throws(() => parseDraft(draft({ lines: 'not json' })));
  assert.throws(() => parseDraft(draft({ period_kind: 'daily' })), /weekly or monthly/);
});
test('reject duplicate schedules and dates outside the period', () => {
  const row = { po_detail_id: 'one', expected_date: '2026-11-03', inward_qty: '2', cost_per_piece: '' };
  assert.throws(() => parseDraft(draft({ lines: JSON.stringify([row, row]) })), /duplicate/);
  assert.throws(() => parseDraft(draft({ lines: JSON.stringify([{ ...row, expected_date: '2026-12-01' }]) })), /period/);
});
test('reject nonfinite, nonpositive or excessively precise quantities and costs', () => {
  const row = { po_detail_id: 'one', expected_date: '2026-11-03', inward_qty: '2', cost_per_piece: '' };
  for (const inward_qty of ['0', '-1', 'NaN', 'Infinity', '1.0001', '1e9', '']) {
    assert.throws(() => parseDraft(draft({ lines: JSON.stringify([{ ...row, inward_qty }]) })), /quantity/);
  }
  for (const cost_per_piece of ['-1', 'NaN', 'Infinity', '1.00001']) {
    assert.throws(() => parseDraft(draft({ lines: JSON.stringify([{ ...row, cost_per_piece }]) })), /cost/);
  }
});


test('product draft stores one total without requiring a SKU or PO detail', () => {
  const lines=[{planning_level:'product',po_number:'PO-1',product_code:'SD',expected_date:'2026-11-03',inward_qty:'150.5',cost_per_piece:'25',remarks:''}];
  const parsed=parseDraft(draft({lines:JSON.stringify(lines)}));
  assert.equal(parsed.lines.length,1);assert.equal(parsed.lines[0].planning_level,'product');
  assert.equal(parsed.lines[0].inward_qty,'150.5');assert.equal(parsed.lines[0].po_detail_id,'');
  assert.throws(()=>parseDraft(draft({lines:JSON.stringify([...lines,...lines])})),/duplicate/);
  assert.throws(()=>parseDraft(draft({lines:JSON.stringify([{...lines[0],product_code:''}])})),/product code/);
});


test('automatic plan titles use the requested monthly and weekly formats', () => {
  assert.equal(planTitle('monthly','2026-10-01'),'IP_Monthly_Oct_2026');
  assert.equal(planTitle('weekly','2026-10-26'),'IP_Weekly_26th Oct, 2026');
  assert.equal(planTitle('monthly','2027-01-01'),'IP_Monthly_Jan_2027');
  for (const [day,suffix] of [[1,'st'],[2,'nd'],[3,'rd'],[11,'th'],[12,'th'],[13,'th'],[21,'st'],[22,'nd'],[23,'rd'],[31,'st']] as const)
    assert.equal(planTitle('weekly',`2026-10-${String(day).padStart(2,'0')}`),`IP_Weekly_${day}${suffix} Oct, 2026`);
  assert.throws(()=>planTitle('weekly','2026-02-30'),/valid planning date/);
});
test('server generates title from period and ignores client title text', () => {
  assert.equal(parseDraft(draft({title:'Custom spoofed title'})).header.title,'IP_Monthly_Nov_2026');
  assert.equal(parseDraft(draft({title:'',period_kind:'weekly',period_start:'2026-10-26',lines:'[]'})).header.title,'IP_Weekly_26th Oct, 2026');
});
