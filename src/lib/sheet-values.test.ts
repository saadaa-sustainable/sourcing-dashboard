import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { isSheetError, sheetBoolean, sheetDate, sheetNumber, sheetText } from './sheet-values';

describe('spreadsheet value coercion', () => {
  it('recognises sheet error sentinels regardless of case or padding', () => {
    assert.equal(isSheetError('#N/A'), true);
    assert.equal(isSheetError('  #ref!  '), true);
    assert.equal(isSheetError('#DIV/0!'), true);
    assert.equal(isSheetError('N/A'), false);
    assert.equal(isSheetError('FY26-27/JOB/SDCP/AF-03'), false);
  });

  it('treats sentinels as absent rather than as text', () => {
    assert.equal(sheetText('#N/A'), null);
    assert.equal(sheetText('  '), null);
    assert.equal(sheetText(' KVN '), 'KVN');
  });

  it('never lets a sentinel masquerade as a completed milestone date', () => {
    assert.equal(sheetDate('#N/A'), null);
    assert.equal(sheetDate('#REF!'), null);
    assert.equal(sheetDate(''), null);
  });

  it('reads dd/mm/yyyy sheet dates without swapping day and month', () => {
    assert.equal(sheetDate('08/09/2025'), '2025-09-08');
    assert.equal(sheetDate('3/1/2026'), '2026-01-03');
    assert.equal(sheetDate('2026-07-30'), '2026-07-30');
  });

  it('rejects impossible calendar dates instead of passing them to Postgres', () => {
    assert.equal(sheetDate('31/02/2026'), null);
    assert.equal(sheetDate('2026-13-01'), null);
    assert.equal(sheetDate('not a date'), null);
  });

  it('coerces sentinels and junk to zero for numeric columns', () => {
    assert.equal(sheetNumber('#N/A'), 0);
    assert.equal(sheetNumber('1,250'), 1250);
    assert.equal(sheetNumber('-46068'), -46068);
    assert.equal(sheetNumber(null), 0);
  });

  it('reads the Match column truthily only for real affirmatives', () => {
    assert.equal(sheetBoolean('TRUE'), true);
    assert.equal(sheetBoolean('FALSE'), false);
    assert.equal(sheetBoolean('#N/A'), false);
  });
});
