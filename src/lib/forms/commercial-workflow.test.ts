import test from 'node:test';
import assert from 'node:assert/strict';
import { commercialFields } from './commercial-validation';
import { commercialImpact, validateCommercialDetails, validCommercialDate, mayEditCommercial, commercialRequestNumber, holdWaiverDays } from './commercial-workflow';

const fd = (type: string, extra: Record<string, string> = {}) => {
  const form = new FormData();
  for (const [key, value] of Object.entries({ business_type: 'fabric', vendor_code: 'ABC', vendor_name: 'ABC Textiles', po_numbers: 'PO-1', request_type: type, remarks: 'Please review', ...extra })) form.set(key, value);
  return form;
};
const proof = JSON.stringify([{ path: 'ABC/00000000-0000-4000-8000-000000000001.pdf', name: 'proof.pdf', size: 100 }]);
test('hold waiver uses calendar days and never monetary impact', () => {
  assert.equal(holdWaiverDays({ hold_start: '2026-10-28', hold_end: '2026-10-31' }), 3);
  assert.equal(holdWaiverDays({ hold_start: '2026-10-28', hold_end: '2026-10-28' }), 0);
  assert.equal(holdWaiverDays({ hold_start: '2026-10-31', hold_end: '2026-10-28' }), null);
  assert.equal(holdWaiverDays({}), null);
  assert.equal(commercialImpact('hold_waiver', { requested_amount: '9999' }, null, null, null), null);
});

test('surplus fabric consumption requires proof and strictly greater than one percent; computes increase server-side', () => {
  const input = fd('surplus_fabric_consumption', { remarks: '', attachments: proof });
  for (const revised of ['100', '99', '101', '100.99']) {
    input.set('details', JSON.stringify({ initial_consumption: '100', revised_consumption: revised }));
    assert.equal(commercialFields(input).ok, false, revised);
    assert.equal(commercialFields(input, true).ok, true);
  }
  input.set('details', JSON.stringify({ initial_consumption: '0.1', revised_consumption: '0.101' }));
  assert.equal(commercialFields(input).ok, false, 'decimal exact 1%');
  input.set('details', JSON.stringify({ initial_consumption: '100', revised_consumption: '102', increased_consumption: '9999' }));
  const result = commercialFields(input);
  assert.equal(result.ok, true);
  if (result.ok) assert.equal(result.v.details.increased_consumption, '2');
  input.set('attachments', '[]');
  assert.equal(commercialFields(input).ok, false);
  for (const details of [{ initial_consumption: '0', revised_consumption: '2' }, { initial_consumption: '1' }, { revised_consumption: '2' }, { initial_consumption: 'Infinity', revised_consumption: '2' }]) {
    input.set('details', JSON.stringify(details));
    assert.equal(commercialFields(input).ok, false);
  }
});

test('GRN delay waiver requires all fields and more than seven calendar days', () => {
  const details = { challan_no: 'CH-1', grn_no: 'GRN-1', delayed_qty: '10', quantity_unit: 'pieces', delivery_date: '2026-10-01', grn_date: '2026-10-09' };
  const input = fd('grn_delay_waiver', { remarks: '', details: JSON.stringify(details) });
  const saved = commercialFields(input);
  assert.equal(saved.ok, true);
  if (saved.ok) assert.equal(saved.v.details.grn_delay_days, '8');
  for (const key of Object.keys(details)) {
    input.set('details', JSON.stringify({ ...details, [key]: '' }));
    assert.equal(commercialFields(input).ok, false, key);
    assert.equal(commercialFields(input, true).ok, true, `${key} draft`);
  }
  for (const grn_date of ['2026-10-08', '2026-10-01', '2026-09-30', '2026-02-30']) {
    input.set('details', JSON.stringify({ ...details, grn_date }));
    assert.equal(commercialFields(input).ok, false, grn_date);
  }
  input.set('details', JSON.stringify({ ...details, delayed_qty: '0' }));
  assert.equal(commercialFields(input).ok, false);
});

test('all five request types have distinct required submission fields', () => {
  for (const type of ['hold_waiver', 'cost_increment', 'cash_discount', 'dn_removal', 'credit_note']) {
    assert.equal(commercialFields(fd(type)).ok, false, type);
    assert.equal(commercialFields(fd(type), true).ok, true, `${type} draft`);
  }
});
test('hold requires dates, quantity, unit, requesting person and proof; compensation and reason are optional', () => {
  const details = { quantity_unit: 'metres', hold_start: '2026-10-27', hold_end: '2026-10-30', hold_requested_by: 'Sourcing team' };
  const input = fd('hold_waiver', { remarks: '', hold_qty: '10', hold_days: '5', ready_date: '2026-10-27', attachments: proof, details: JSON.stringify(details) });
  assert.equal(commercialFields(input).ok, true);
  for (const key of Object.keys(details)) {
    input.set('details', JSON.stringify({ ...details, [key]: '' }));
    assert.equal(commercialFields(input).ok, false, key);
    assert.equal(commercialFields(input, true).ok, true, `${key} draft`);
  }
  input.set('details', JSON.stringify(details));
  input.set('attachments', '[]');
  assert.equal(commercialFields(input).ok, false);
  assert.equal(commercialFields(input, true).ok, true);
  input.set('attachments', proof);
  input.set('hold_days', '');
  assert.equal(commercialFields(input).ok, false);
  input.set('hold_days', '5');
  input.set('ready_date', '2026-02-30');
  assert.equal(commercialFields(input).ok, false);
  input.set('ready_date', '2026-10-27'); input.set('hold_qty', '0');
  assert.equal(commercialFields(input).ok, false);
});
test('cost increment requires rate, reasons and remarks; retains legacy impact calculations', () => {
  const input = fd('cost_increment', { cost_reason: 'dye_rate,other', increment_amount: '2.5', details: JSON.stringify({ quantity_unit: 'metres', current_rate: '100', affected_quantity: '1000', affected_items: 'Blue fabric' }) });
  assert.equal(commercialFields(input).ok, false);
  assert.equal(commercialFields(input, true).ok, true);
  input.set('cost_reason_other', 'Special finish');
  assert.equal(commercialFields(input).ok, true);
  assert.equal(commercialImpact('cost_increment', { affected_quantity: '1000' }, 2.5, null, null), 2500);
  input.set('cost_reason', 'invented'); assert.equal(commercialFields(input).ok, false);
  for (const business of ['fabric', 'garment']) {
    const request = fd('cost_increment', { business_type: business, cost_reason: 'other', cost_reason_other: 'Manual reason', increment_amount: '2' });
    assert.equal(commercialFields(request).ok, true);
    for (const key of ['remarks', 'cost_reason', 'increment_amount', 'cost_reason_other']) {
      const previous = request.get(key)!;
      request.set(key, '');
      assert.equal(commercialFields(request).ok, false, key);
      assert.equal(commercialFields(request, true).ok, true, `${key} draft`);
      request.set(key, previous);
    }
    request.set('increment_amount', '0');
    assert.equal(commercialFields(request).ok, false);
  }
});
test('cash discount requires contact, invoice identity, RG and remarks but allows no amount or invoice copy', () => {
  const input = fd('cash_discount', { owner_name: 'Owner', owner_contact: '+91 9876543210', invoice_number: 'I-1', invoice_date: '2026-10-27', invoice_amount: '10000', rg_pending: 'None', details: JSON.stringify({ cd_percent: '2', payment_deadline: '2026-10-30', payment_terms: 'Pay within 3 days' }) });
  assert.equal(commercialFields(input).ok, true);
  input.set('invoice_amount', '');
  assert.equal(commercialFields(input).ok, true);
  for (const key of ['owner_name', 'owner_contact', 'invoice_number', 'invoice_date', 'rg_pending', 'remarks']) {
    const previous = input.get(key)!;
    input.set(key, '');
    assert.equal(commercialFields(input).ok, false, key);
    assert.equal(commercialFields(input, true).ok, true, `${key} draft`);
    input.set(key, previous);
  }
  input.set('attachments', proof); assert.equal(commercialFields(input).ok, true);
  input.set('details', '{}'); assert.equal(commercialFields(input).ok, true, 'CD submission does not require discount percentage, deadline or payment terms');
  input.set('owner_contact', 'invalid'); assert.equal(commercialFields(input).ok, false);
  assert.equal(commercialImpact('cash_discount', { cd_percent: '2' }, null, 10000, null), 200);
});
test('DN supports partial removal and credit note records issuer and tax basis', () => {
  const dn = fd('dn_removal', { debit_note_number: 'DN-1', attachments: proof, details: JSON.stringify({ dn_date: '2026-10-27', dn_amount: '500', requested_amount: '200' }) });
  assert.equal(commercialFields(dn).ok, true);
  for (const key of ['debit_note_number', 'remarks', 'attachments']) {
    const previous = dn.get(key)!;
    dn.set(key, key === 'attachments' ? '[]' : '');
    assert.equal(commercialFields(dn).ok, false, `${key} required`);
    assert.equal(commercialFields(dn, true).ok, true, `${key} draft`);
    dn.set(key, previous);
  }
  dn.set('details', JSON.stringify({ dn_date: '2026-10-27', dn_amount: '500', requested_amount: '501' }));
  assert.equal(commercialFields(dn).ok, false);
  const credit = fd('credit_note', { credit_amount: '500', attachments: proof, details: JSON.stringify({ issuer: 'Vendor to SAADAA', related_invoice: 'I-1', tax_basis: 'Including tax' }) });
  assert.equal(commercialFields(credit).ok, true);
  credit.set('attachments', proof.replace('ABC/', 'OTHER/')); assert.equal(commercialFields(credit).ok, false);
});
test('rejects numeric, date, object and enum abuse', () => {
  assert.equal(validCommercialDate('2026-02-30'), false);
  assert.equal(validCommercialDate('2028-02-29'), true);
  for (const details of [null, [], { cd_percent: 'Infinity' }, { cd_percent: '-1' }, { cd_percent: '101' }, { cd_percent: {} }]) assert.throws(() => validateCommercialDetails('cash_discount', details, true));
  assert.throws(() => validateCommercialDetails('hold_waiver', { quantity_unit: 'unknown' }, true));
  assert.throws(() => validateCommercialDetails('hold_waiver', { hold_start: '2026-10-28', hold_end: '2026-10-27' }, true));
  assert.deepEqual(validateCommercialDetails('credit_note', { malicious: 'ignored' }, true), {});
});
test('ownership and approved lock follow house rule', () => {
  for (const status of ['draft', 'pending_l2', 'rework', 'rejected']) {
    assert.equal(mayEditCommercial('vendor@example.com', false, 'vendor@example.com', status), true);
    assert.equal(mayEditCommercial('other@example.com', false, 'vendor@example.com', status), false);
    assert.equal(mayEditCommercial('admin@saadaa.in', true, 'vendor@example.com', status), true);
  }
  assert.equal(mayEditCommercial('admin@saadaa.in', true, 'vendor@example.com', 'approved'), false);
  assert.equal(commercialRequestNumber(42, '2026-10-27T00:00:00Z'), 'CAR-2026-000042');
});
