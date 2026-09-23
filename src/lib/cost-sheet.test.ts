import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { costSheetCsvUrl, parseCostSheet, sheetNumber } from './cost-sheet';

// The real thing: "CFK - COST SHEET - SDFLK NEW PO", exported as CSV. Kept verbatim,
// blank columns and trailing spaces included, because that IS the shape being parsed.
const SHEET = `FY26-27/EFOB/SDFLK/CFK-02,,,,,,,,,,,,,,
STANDARD DOQ RATIO ,0.00,29.76,45.00,54.61,54.89,33.19,24.37,18.55,,PO AVG,,,,
"56"" W - AVG Fabric consumption (IN MTR)",1.29,1.39,1.44,1.48,1.50,1.59,1.73,1.91,,1.56,,SDFSK - AIRY LINEN LONG KURTA,,
AIRY LINEN LONG KURTA,XS,S,M,L,XL,2XL,3XL,4XL,,,,CMTP Charges,SAADAA FINAL RATE,Detail
,,,,,,,,,,,,Karigar,48,
GREIGE RATE ( L 100 ),,,,,,,,,,,,Thekedar Commission,4.8,10%
DYEING COST ,,,,,,,,,,,,Absolute labour Cost,52.8,
SHRINKAGE,,,,,,,,,,,,Cutting,5,
,,,,,,,,,,,,Packing  - polybag,1.5,
DYED FABRIC COST (INR / Mtr),115,115,115,115,115,115,115,115,,120,,thread cutting,2,
,,,,,,,,,,,,final QC,3,
FABRIC COST,148.6,159.5,165.4,169.6,172.2,182.8,198.5,220.1,,187.20,,fabric QC,0.48,
CMTP ,80,80,80,80,80,80,80,80,,80,,Folding,2,
,,,,,,,,,,,,Iron,4,
TOTAL GARMENT COST ,228.9,239.8,245.7,249.9,252.5,263.1,278.8,300.3,,267.48,,Thread,2,
,,,,,,,,,,,,Button,1.5,Shell button
MARGIN (15%),34.33,35.97,36.86,37.49,37.87,39.47,41.82,45.05,,40.12,,Brand Trims,5,(including rejection though cost is 4.5)
,,,,,,,,,,,,Fusing,1,
TOTAL ,263.19,275.74,282.58,287.42,290.33,302.57,320.63,345.38,,307.60,,,,
,,,,,,,,,,,,FINAL CMTP ,80,
FINAL PRICE -,265.00,275.00,285.00,285.00,290.00,305.00,320.00,345.00,,310.00,,,,
,,,,,,,,,,,,VENDOR MARGIN ,15%,
,,,,,,,,,,,,PAYMENT TERMS ( DAYS ),45,
,,,,,,,,,,,,,,
,255.000,270.000,275.000,280.000,285.000,295.000,315.000,335.000,,275.000,,,,`;

describe('reading the team cost sheet', () => {
  const f = parseCostSheet(SHEET);

  it('takes each figure from the PO AVG column, by label', () => {
    assert.equal(f.avgColumnLabel, 'PO AVG');
    assert.equal(f.rate, 310); // FINAL PRICE, not the TOTAL of 307.60
    assert.equal(f.fabricCost, 187.2);
    assert.equal(f.totalGarmentCost, 267.48);
    assert.equal(f.avgConsumption, 1.56);
    assert.equal(f.warnings.length, 0);
  });

  it('reads the right-hand build-up from the cell beside its label', () => {
    assert.equal(f.cmCost, 80); // FINAL CMTP
    assert.equal(f.marginPct, 15); // VENDOR MARGIN, written "15%"
    assert.equal(f.paymentTermsDays, 45);
  });

  it('does not confuse DYED FABRIC COST with FABRIC COST', () => {
    assert.equal(f.dyedFabricRate, 120);
    assert.notEqual(f.fabricCost, f.dyedFabricRate);
  });

  it('leaves a blank row blank rather than inventing a number', () => {
    // GREIGE RATE has no figures on this sheet, and the unlabelled last row is ignored.
    assert.equal(f.greyCost, null);
  });

  it('keeps the per-size prices and the names at the top', () => {
    assert.equal(f.poRef, 'FY26-27/EFOB/SDFLK/CFK-02');
    assert.equal(f.productName, 'AIRY LINEN LONG KURTA');
    assert.deepEqual(
      f.sizes.map((s) => `${s.size}:${s.finalPrice}`),
      ['XS:265', 'S:275', 'M:285', 'L:285', 'XL:290', '2XL:305', '3XL:320', '4XL:345'],
    );
  });

  it('falls back to the margin written into the label when there is no vendor-margin line', () => {
    const noVendorMargin = SHEET.split('\n')
      .filter((l) => !l.includes('VENDOR MARGIN'))
      .join('\n');
    assert.equal(parseCostSheet(noVendorMargin).marginPct, 15); // from "MARGIN (15%)"
  });

  it('says what it could not find instead of guessing', () => {
    const empty = parseCostSheet('');
    assert.equal(empty.rate, null);
    assert.ok(empty.warnings.length);
    const noPrice = parseCostSheet('FABRIC COST,10,,20\nCMTP,5,,5');
    assert.ok(noPrice.warnings.some((w) => w.includes('PO AVG')));
    assert.ok(noPrice.warnings.some((w) => w.toLowerCase().includes('rate')));
  });

  it('reads numbers the way a sheet writes them', () => {
    assert.equal(sheetNumber('1,234.50'), 1234.5);
    assert.equal(sheetNumber(' ₹ 120 '), 120);
    assert.equal(sheetNumber('15%'), 15);
    assert.equal(sheetNumber('(45)'), -45);
    assert.equal(sheetNumber(''), null);
    assert.equal(sheetNumber('n/a'), null);
  });

  it('turns a Google Sheets link into its CSV export, keeping the tab', () => {
    assert.equal(
      costSheetCsvUrl('https://docs.google.com/spreadsheets/d/1AbC-_123/edit#gid=456'),
      'https://docs.google.com/spreadsheets/d/1AbC-_123/export?format=csv&gid=456',
    );
    assert.equal(
      costSheetCsvUrl('https://docs.google.com/spreadsheets/d/1AbC-_123/edit?usp=sharing'),
      'https://docs.google.com/spreadsheets/d/1AbC-_123/export?format=csv',
    );
    assert.equal(costSheetCsvUrl('https://drive.google.com/file/d/xyz/view'), null);
    assert.equal(costSheetCsvUrl(''), null);
  });
});
