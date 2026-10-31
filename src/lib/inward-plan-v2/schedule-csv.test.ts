import assert from 'node:assert/strict';
import { test } from 'node:test';
import { parseScheduleCsv, SCHEDULE_CSV_HEADERS } from './schedule-csv';
import type { HeaderDraft, ProductSource } from './types';

const header: HeaderDraft = { title: '', remarks: '', period_kind: 'monthly', period_start: '2026-10-01' };
const source: ProductSource = { po_number: 'PO-1', po_ref_num: 'REF-1', product_code: 'SD', vendor_name: 'Real vendor', pending_qty: 100, item_price: 25, expected_delivery_date: null };
const csv = (row: string) => SCHEDULE_CSV_HEADERS.join(',') + '\r\n' + row;
const parse = (text: string) => parseScheduleCsv(text, header, [source], []);

test('CSV resolves a unique real PO/product and preserves quoted commas, quotes and newlines', () => {
  const [line] = parse('\uFEFF' + csv('REF-1,sd,30/10/2026,2,,"Check, ""quoted""\nremark"'));
  assert.equal(line.po_number, 'PO-1'); assert.equal(line.product_code, 'SD');
  assert.equal(line.vendor_name, 'Real vendor'); assert.equal(line.cost_per_piece, '25');
  assert.equal(line.expected_date, '2026-10-30'); assert.equal(line.remarks, 'Check, "quoted"\nremark');
  assert.equal(line.planning_level, 'product'); assert.equal(line.id, undefined);
});
test('CSV rejects missing headers, duplicate headers, empty data and malformed quoting', () => {
  for (const text of ['PO,Quantity\nPO-1,1', 'PO No,PO No\nPO-1,PO-1', SCHEDULE_CSV_HEADERS.join(','), csv('PO-1,SD,2026-10-30,1,,"broken'), csv('PO-1,SD,2026-10-30,1,,"ok"bad')])
    assert.throws(() => parse(text));
});
test('all row errors are reported without returning a partial import', () => {
  assert.throws(() => parse(csv('PO-1,SD,2026-10-30,2,,') + '\nmissing,SD,2026-10-30,1,,\nPO-1,SD,2026-11-01,1,,'), error =>
    error instanceof Error && error.message.includes('CSV row 3') && error.message.includes('CSV row 4'));
});
test('CSV enforces real PO/product identity, rejects loose matches and ambiguous references', () => {
  assert.throws(() => parse(csv('PO-1,UNKNOWN,2026-10-30,1,,')), /open approved PO/);
  assert.throws(() => parse(csv('PO,SD,2026-10-30,1,,')), /open approved PO/);
  assert.throws(() => parseScheduleCsv(csv('REF-1,SD,2026-10-30,1,,'), header, [source, { ...source, po_number: 'PO-2' }], []), /ambiguous/);
  assert.equal(parseScheduleCsv(csv('PO-1,SD,2026-10-30,1,,'), header, [source, { ...source, po_number: 'PO-2', po_ref_num: 'PO-1' }], [])[0].po_number, 'PO-1');
});
test('dates and numeric precision follow schedule validation', () => {
  for (const row of ['PO-1,SD,2026-02-30,1,,', 'PO-1,SD,2026-11-01,1,,', 'PO-1,SD,2026-10-30,0,,', 'PO-1,SD,2026-10-30,1.0001,,', 'PO-1,SD,2026-10-30,1,-2,'])
    assert.throws(() => parse(csv(row)));
  assert.equal(parse(csv('PO-1,SD,2026-10-30,0.125,12.3400,'))[0].cost_per_piece, '12.3400');
});
test('duplicate schedules and combined pending quantity are checked against existing entries', () => {
  const existing = parse(csv('PO-1,SD,2026-10-28,60,,'));
  assert.throws(() => parseScheduleCsv(csv('PO-1,SD,2026-10-28,1,,'), header, [source], existing), /Duplicate/);
  assert.throws(() => parseScheduleCsv(csv('PO-1,SD,2026-10-29,41,,'), header, [source], existing), /combined schedule quantity/);
  assert.equal(parseScheduleCsv(csv('PO-1,SD,2026-10-29,40,,'), header, [source], existing).length, 1);
  assert.equal(existing[0].inward_qty, '60');
});
test('fractional combined quantities do not produce a false pending excess', () => {
  const rows = csv('PO-1,SD,2026-10-28,0.1,,') + '\nPO-1,SD,2026-10-29,0.2,,';
  assert.equal(parseScheduleCsv(rows, header, [{ ...source, pending_qty: 0.3 }], []).length, 2);
});
test('CSV import respects the total line limit and weekly boundaries', () => {
  const existing = Array.from({ length: 500 }, () => parse(csv('PO-1,SD,2026-10-28,1,,'))[0]);
  assert.throws(() => parseScheduleCsv(csv('PO-1,SD,2026-10-29,1,,'), header, [source], existing), /500/);
  const weekly = { ...header, period_kind: 'weekly' as const, period_start: '2026-10-26' };
  assert.equal(parseScheduleCsv(csv('PO-1,SD,2026-11-01,1,,'), weekly, [source], []).length, 1);
  assert.throws(() => parseScheduleCsv(csv('PO-1,SD,2026-11-02,1,,'), weekly, [source], []), /planning period/);
});
