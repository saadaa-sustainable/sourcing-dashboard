import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseInwardPlanCsv, splitCsv } from './inward-plan-csv';

const SHEET = [
  'INWARD PLAN,Oct Month,Approved QTY,,0,Approved Value,0',
  'Auto,Manual Input,Auto,,64030,,15269050',
  'PRODUCT CODE,PO NO.,Vendor name,In-Process Qty,Inward qty. this month,Cost/Piece,Total Value',
  'SDFSK,FY26-27/JOB/SDFSK/AF-06,AF,635,600,80,48000',
  'sdflk,FY26-27/JOB/SDFLK/AF-12,AF,540,"1,540",95,146300',
  'SMCP,FY25-26/FOB/SMCP/AFP-16,AFP,5042,0,245,0',
  ',,,,,,',
  'SDAWC,FY26-27/JOB/SDAWC/BAH-11,BAH,1785,abc,190,190000',
].join('\r\n');

test('finds the header row below the sheet title rows and reads the five columns', () => {
  const r = parseInwardPlanCsv(SHEET);
  assert.equal(r.error, undefined);
  assert.equal(r.rows.length, 2);
  assert.deepEqual(r.rows[0], {
    product_code: 'SDFSK', po_no: 'FY26-27/JOB/SDFSK/AF-06', vendor_name: 'AF', inward_qty: 600, cost_per_piece: 80, line: 4,
  });
  // Product codes are upper-cased; thousands separators are accepted.
  assert.equal(r.rows[1].product_code, 'SDFLK');
  assert.equal(r.rows[1].inward_qty, 1540);
});

test('skips zero-qty and unreadable rows and says why, ignoring blank lines', () => {
  const r = parseInwardPlanCsv(SHEET);
  assert.deepEqual(r.skipped.map((s) => s.reason), ['inward qty is zero', 'inward qty "abc" is not a number']);
});

test('reports a missing header instead of guessing columns', () => {
  const r = parseInwardPlanCsv('a,b,c\n1,2,3');
  assert.match(r.error ?? '', /header row/);
  assert.equal(r.rows.length, 0);
});

test('splitCsv handles quoted commas and doubled quotes', () => {
  assert.deepEqual(splitCsv('a,"b,c","say ""hi"""\n'), [['a', 'b,c', 'say "hi"']]);
});
