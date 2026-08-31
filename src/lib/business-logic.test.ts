import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { ageingBucket, buildTnaEvents, buildTrackerRows, buildVendorRollups, computeClosureCompliance, computeInternalStatus, deriveTnaStage, easycomBucket, hasTnaSequenceError, isTnaDueToday, isEasycomActive, isTnaDataMissing, isTnaHighRisk, istToday, stageDelay, normaliseVendorType, tnaSequenceErrors, vendorBucket, vendorPoCapacity } from './business-logic';
import { sheetDate } from './sheet-values';
import type { PendingPo, TnaRecord } from './types';

const base: PendingPo = { po_number:'1',po_created_date:null,po_date:null,item_price:100,po_id:'1',sku:'A',product_description:null,cp_id:'1',po_detail_id:'1',original_quantity:10,pending_quantity:10,size:'M',po_status:'Approved',vendor_name:'Vendor',vendor_code:'V1',expected_delivery_date:'2026-07-20',po_ref_num:'PO-1',product_variant:'RED',product_code:'P1',pending_qty_actual:10,po_type:'JOB',match_flag:true };
const tna: TnaRecord = { po_no:'PO-1',po_issued_date:null,po_qty:10,pp_sample_tna_date:null,pp_sample_actual_date:'2026-01-01',pp_sample_delay_days:0,gpt_tna_date:null,gpt_actual_date:null,gpt_delay_days:0,cutting_tna_date:null,cutting_actual_date_first:null,cutting_delay_days:0,in_line_tna_date:null,in_line_actual_date:null,in_line_qc_delay_days:0 };

describe('sourcing business rules', () => {
  it('buckets woven and knit by keyword, everything else as Other', () => { assert.equal(vendorBucket('Premium Woven Unit'),'Woven'); assert.equal(vendorBucket('Knitted'),'Knit'); assert.equal(vendorBucket('Circular Knit'),'Knit'); assert.equal(vendorBucket('Trims Supplier'),'Other'); assert.equal(vendorBucket(''),'Other'); assert.equal(vendorBucket(null),'Other'); });
  it('derives the first missing TNA actual stage', () => { assert.equal(deriveTnaStage(tna),'GPT Pending'); assert.equal(deriveTnaStage(null),'Not in TNA Tracker'); });
  it('does not report an unresolved #N/A milestone as complete', () => {
    // Mirrors FY25-26/EFOB/SDLNS/STR-02: PP sample never taken, later stages filled in.
    // Passing "#N/A" through as text made every stage look done and reported "Production".
    const raw = { pp_sample_actual_date:'#N/A', gpt_actual_date:'25/04/2026', cutting_actual_date_first:'18/04/2026', in_line_actual_date:'#N/A' };
    const parsed: TnaRecord = { ...tna,
      pp_sample_actual_date: sheetDate(raw.pp_sample_actual_date), gpt_actual_date: sheetDate(raw.gpt_actual_date),
      cutting_actual_date_first: sheetDate(raw.cutting_actual_date_first), in_line_actual_date: sheetDate(raw.in_line_actual_date) };
    assert.equal(deriveTnaStage(parsed),'PP Sample Pending');
  });
  it('keeps missing EDD rows in No EDD', () => { assert.equal(ageingBucket(null),'No EDD'); });
  it('resolves today in IST, not UTC, so it is never a day behind', () => {
    // 2026-08-03 20:30 UTC = 2026-08-04 02:00 IST → today must be Aug 4, not Aug 3.
    assert.equal(istToday(new Date('2026-08-03T20:30:00Z')).toISOString(),'2026-08-04T00:00:00.000Z');
    assert.equal(istToday(new Date('2026-08-04T10:00:00Z')).toISOString(),'2026-08-04T00:00:00.000Z');
    // IST-midnight boundary is 18:30 UTC.
    assert.equal(istToday(new Date('2026-08-03T18:30:00Z')).toISOString(),'2026-08-04T00:00:00.000Z');
    assert.equal(istToday(new Date('2026-08-03T18:29:59Z')).toISOString(),'2026-08-03T00:00:00.000Z');
  });
  it('groups by PO reference and product code and counts distinct variants', () => {
    const rows=buildTrackerRows([base,{...base,po_detail_id:'2',sku:'B',product_variant:'BLUE',pending_qty_actual:5},{...base,po_detail_id:'3',sku:'C',product_variant:'BLUE',pending_qty_actual:2}],[],[],[tna],new Date('2026-07-15T00:00:00Z'));
    assert.equal(rows.length,1); assert.equal(rows[0].variantCount,2); assert.equal(rows[0].pendingQty,17); assert.equal(rows[0].stage,'GPT Pending');
  });
  it('flags a PO with no TNA data as an adoption gap (not partially-filled)', () => {
    assert.equal(isTnaDataMissing(null), true);
    assert.equal(isTnaDataMissing({ ...tna, pp_sample_actual_date: null }), true);
    assert.equal(isTnaDataMissing(tna), false);
    assert.equal(isTnaDataMissing({ ...tna, pp_sample_actual_date: null, gpt_tna_date: '2026-05-01' }), false);
  });
  it('drops non-Approved EasyCom lines and sets poNumber/variantName/tnaMissing', () => {
    assert.equal(isEasycomActive(base), true);
    assert.equal(isEasycomActive({ ...base, po_status: 'Completed' }), false);
    assert.equal(isEasycomActive({ ...base, po_status: 'cancelled' }), false);
    const rows = buildTrackerRows([base, { ...base, po_detail_id: 'X', po_status: 'Completed' }], [], [], [tna], new Date('2026-07-15T00:00:00Z'));
    assert.equal(rows.length, 1);
    assert.equal(rows[0].poNumber, '1');
    assert.equal(rows[0].variantName, 'RED');
    assert.equal(rows[0].tnaMissing, false);
  });
  it('attaches per-stage inspections to the tracker row by normalized PO ref', () => {
    const insp = { 'PO-1': { gpt: { passDate:'2026-07-10', reportUrl:'http://x/pass', count:3, failCount:2, entries:[] } } };
    const [row] = buildTrackerRows([base],[],[],[tna],new Date('2026-07-15T00:00:00Z'), insp);
    assert.equal(row.inspections?.gpt?.count, 3);
    assert.equal(row.inspections?.gpt?.failCount, 2);
    assert.equal(row.inspections?.gpt?.reportUrl, 'http://x/pass');
    assert.equal(row.inspections?.pp, undefined);
  });
  it('splits one PO + product code across its distinct EDDs instead of letting row order pick one', () => {
    // Mirrors FY26-27/JOB/SDAMK/STN-01: same PO and product, lines dated two months apart.
    // Keyed on PO + product alone, whichever line sorted first silently decided whether the
    // whole group read as 44 days overdue or not due at all.
    const overdue={...base,po_detail_id:'A',expected_delivery_date:'2026-06-01',pending_qty_actual:4};
    const upcoming={...base,po_detail_id:'B',expected_delivery_date:'2026-07-31',pending_qty_actual:6};
    const today=new Date('2026-07-15T00:00:00Z');
    const rows=buildTrackerRows([overdue,upcoming],[],[],[tna],today);
    assert.equal(rows.length,2);
    const byEdd=Object.fromEntries(rows.map((row)=>[row.edd,row]));
    assert.equal(byEdd['2026-06-01'].delayDays,44); assert.equal(byEdd['2026-06-01'].delayBucket,'30+ Days');
    assert.equal(byEdd['2026-07-31'].delayDays,0); assert.equal(byEdd['2026-07-31'].delayBucket,'Not Due');
    // Reversing the input must not change either verdict.
    const reversed=buildTrackerRows([upcoming,overdue],[],[],[tna],today);
    assert.deepEqual(reversed.map((r)=>[r.edd,r.delayDays]).sort(),rows.map((r)=>[r.edd,r.delayDays]).sort());
  });
  it('evaluates High Risk live, not as a sticky tag: due-and-not-done flags it; marking done (even late) clears it', () => {
    const today = new Date('2026-07-21T00:00:00Z');
    // GPT due the 20th, not done, today is the 21st -> High Risk today.
    const gptOverdue = { ...tna, gpt_tna_date: '2026-07-20', gpt_actual_date: null };
    assert.equal(isTnaHighRisk(gptOverdue, today), true);
    // GPT marked done on the 22nd (late) -> immediately NOT High Risk (re-evaluated fresh).
    assert.equal(isTnaHighRisk({ ...gptOverdue, gpt_actual_date: '2026-07-22' }, today), false);
    // Planned date still in the future -> not High Risk.
    assert.equal(isTnaHighRisk({ ...tna, gpt_tna_date: '2026-07-25', gpt_actual_date: null }, today), false);
  });
  it('flags out-of-sequence TNA stages (later done while earlier blank)', () => {
    // Valid: no actuals -> no error; unbroken prefix -> no error.
    assert.deepEqual(tnaSequenceErrors({ ...tna, pp_sample_actual_date: null }), []);
    assert.equal(hasTnaSequenceError({ ...tna, pp_sample_actual_date: '2026-01-01', gpt_actual_date: null }), false);
    // Invalid: GPT done but PP Sample blank -> GPT is out of sequence; current stage is PP Sample.
    const bad = { ...tna, pp_sample_actual_date: null, gpt_actual_date: '2026-02-01' };
    assert.deepEqual(tnaSequenceErrors(bad), ['GPT']);
    assert.equal(hasTnaSequenceError(bad), true);
    assert.equal(deriveTnaStage(bad), 'PP Sample Pending');
    // Gap in the middle: PP done, GPT blank, Cutting done -> Cutting flagged.
    assert.deepEqual(
      tnaSequenceErrors({ ...tna, pp_sample_actual_date: '2026-01-01', gpt_actual_date: null, cutting_actual_date_first: '2026-03-01' }),
      ['Cutting'],
    );
  });
  it('computes per-stage on-time / delay / pending variance', () => {
    assert.deepEqual(stageDelay('2026-07-10', '2026-07-15'), { state: 'Delay', days: 5 });
    assert.deepEqual(stageDelay('2026-07-15', '2026-07-10'), { state: 'On Time', days: 5 });
    assert.deepEqual(stageDelay('2026-07-15', '2026-07-15'), { state: 'On Time', days: 0 });
    assert.deepEqual(stageDelay('2026-07-15', null), { state: 'Pending', days: 0 });
    assert.deepEqual(stageDelay(null, '2026-07-15'), { state: 'None', days: 0 });
    assert.deepEqual(stageDelay(null, null), { state: 'None', days: 0 });
  });
  it('computes EasyCom partial-delivery and the internal-status precedence', () => {
    const today = new Date('2026-07-15T00:00:00Z');
    const partial = { ...base, original_quantity: 10, pending_qty_actual: 4 };
    const [prow] = buildTrackerRows([partial], [], [], [], today);
    assert.equal(prow.easycomStatus, 'Partially Received');
    assert.equal(prow.receivedQty, 6); assert.equal(prow.orderedQty, 10);
    const fresh = { ...base, original_quantity: 10, pending_qty_actual: 10 };
    assert.equal(buildTrackerRows([fresh], [], [], [], today)[0].easycomStatus, 'Approved');
    assert.equal(easycomBucket(10, 0), 'Approved');
    assert.equal(easycomBucket(10, 5), 'Partially Received');
    assert.equal(easycomBucket(10, 10), 'Closure Pending');
    assert.equal(easycomBucket(100, 96), 'Closure Pending');
    const done = { ...base, po_detail_id: 'D', original_quantity: 10, pending_qty_actual: 0 };
    assert.equal(buildTrackerRows([done], [], [], [], today).length, 0);
    assert.equal(buildTrackerRows([done], [], [], [], today, undefined, { includeClosurePending: true })[0].easycomStatus, 'Closure Pending');
    assert.equal(computeInternalStatus({ delayDays: 14, highRisk: true }), 'Overdue');
    assert.equal(computeInternalStatus({ delayDays: 0, highRisk: true }), 'High Risk');
    assert.equal(computeInternalStatus({ delayDays: 0, highRisk: false }), 'On Track');
  });
  it('flags a stage due today, distinct from overdue (Layer 3 Due Today)', () => {
    const t = new Date('2026-07-15T00:00:00Z');
    assert.equal(isTnaDueToday({ ...tna, gpt_tna_date: '2026-07-15' }, t), true);
    assert.equal(isTnaDueToday({ ...tna, gpt_tna_date: '2026-07-10' }, t), false);
    assert.equal(isTnaDueToday(tna, t), false);
    assert.equal(buildTrackerRows([base], [], [], [{ ...tna, gpt_tna_date: '2026-07-15' }], t)[0].dueToday, true);
  });
  it('surfaces TNA milestones due today and overdue as events, skipping future ones', () => {
    const today = new Date('2026-07-15T00:00:00Z');
    const eventTna: TnaRecord = { ...tna,
      pp_sample_tna_date:'2026-07-15', pp_sample_actual_date:null,   // due today
      gpt_tna_date:'2026-07-10', gpt_actual_date:null,               // 5 days overdue
      cutting_tna_date:'2026-07-20', cutting_actual_date_first:null }; // future — not an event
    const rows = buildTrackerRows([base],[],[],[eventTna],today);
    const events = buildTnaEvents(rows, today);
    const due = events.filter((e)=>e.status==='today');
    const late = events.filter((e)=>e.status==='delayed');
    assert.equal(due.length,1); assert.equal(due[0].stage,'PP Sample'); assert.equal(due[0].overdueDays,0);
    assert.equal(late.length,1); assert.equal(late[0].stage,'GPT'); assert.equal(late[0].overdueDays,5);
    assert.equal(events.some((e)=>e.stage==='Cutting'),false);
  });
  it('emits each PO + stage event once even when the PO is split across EDDs', () => {
    // A PO split across EDDs yields multiple tracker rows sharing one TNA record;
    // the PO-level milestone must not be duplicated per row.
    const today = new Date('2026-07-15T00:00:00Z');
    const eventTna: TnaRecord = { ...tna, pp_sample_tna_date:'2026-07-15', pp_sample_actual_date:null };
    const overdue={...base,po_detail_id:'A',expected_delivery_date:'2026-06-01',pending_qty_actual:4};
    const upcoming={...base,po_detail_id:'B',expected_delivery_date:'2026-07-31',pending_qty_actual:6};
    const rows=buildTrackerRows([overdue,upcoming],[],[],[eventTna],today);
    assert.equal(rows.length,2);
    const events=buildTnaEvents(rows,today);
    assert.equal(events.filter((e)=>e.stage==='PP Sample').length,1);
  });
  it('still counts a split PO once per vendor and flags it delayed if any line is overdue', () => {
    const overdue={...base,po_detail_id:'A',expected_delivery_date:'2026-06-01',pending_qty_actual:4};
    const upcoming={...base,po_detail_id:'B',expected_delivery_date:'2026-07-31',pending_qty_actual:6};
    const [vendor]=buildVendorRollups([overdue,upcoming],[],[],[tna],new Date('2026-07-15T00:00:00Z'));
    assert.equal(vendor.openPoCount,1); assert.equal(vendor.delayedPoCount,1); assert.equal(vendor.openQty,10);
  });
  it('derives PO capacity from machines x karigar x type multiplier; utilisation from monthly capacity', () => {
    assert.equal(vendorPoCapacity(20, 25, 'E-FOB'), 750);
    assert.equal(vendorPoCapacity(10, 10, 'FOB'), 250);
    assert.equal(vendorPoCapacity(5, 4, 'EFOB/FOB'), 40);
    assert.equal(normaliseVendorType('EFOB/FOB'), 'efob_fob');
    const cap = new Map([['v1', { machines: 20, karigar: 25 }]]);
    const line = { ...base, po_ref_num: 'PO-9', vendor_code: 'V1', pending_qty_actual: 300, expected_delivery_date: '2026-09-01' };
    const vt = { vendor_name: 'V1', vendor_code: 'V1', vendor_type: 'E-FOB', merchant_name: null, status: 'active' };
    const vm = {
      vendor_code: 'V1', vendor_name: 'V1', onboarding_date: null, merchant_name: null,
      primary_type: 'E-FOB', total_machines: 20, total_active_karigar: 25, machines_for_saadaa: 20,
      capacity_per_month: 1000, karigar_latest: 25, karigar_latest_as_of: null, ee_status: null,
    };
    const [v] = buildVendorRollups([line], [vt], [vm], [], new Date('2026-07-15T00:00:00Z'), cap);
    assert.equal(v.poCapacity, 750);
    // Utilisation = open qty (300) ÷ monthly capacity (1000) = 30%.
    assert.equal(v.utilizationPct, 30);
  });
});

describe('PO closure SLA compliance', () => {
  const today = istToday(new Date('2026-08-31T06:00:00Z'));
  const open = (over: Partial<Parameters<typeof computeClosureCompliance>[0]>) =>
    computeClosureCompliance(
      { easycom_completed_at: null, sourcing_status: 'pending', sourcing_submitted_at: null, finance_submitted_at: null, closed_at: null, ...over },
      today,
    );

  it('is green early in the sourcing leg', () => {
    const c = open({ easycom_completed_at: '2026-08-29' }); // 2 days in
    assert.equal(c.leg, 'sourcing');
    assert.equal(c.rag, 'green');
    assert.equal(c.status, 'on_time');
  });

  it('goes amber at day 5-7 of the open leg', () => {
    const c = open({ easycom_completed_at: '2026-08-25' }); // 6 days in
    assert.equal(c.rag, 'amber');
  });

  it('reads red for a still-open PO already past the 15-day total cap', () => {
    const c = open({ easycom_completed_at: '2026-08-10' }); // 21 days, still open
    assert.equal(c.status, 'breached');
    assert.equal(c.rag, 'red');
    assert.equal(c.totalDays, 21);
  });

  it('measures the finance leg from the sourcing submission, and closes on time', () => {
    const c = computeClosureCompliance(
      { easycom_completed_at: '2026-08-20', sourcing_status: 'submitted', sourcing_submitted_at: '2026-08-24', finance_submitted_at: '2026-08-28', closed_at: '2026-08-28' },
      today,
    );
    assert.equal(c.leg, 'closed');
    assert.equal(c.daysToMerch, 4);
    assert.equal(c.daysToFinance, 4);
    assert.equal(c.totalDays, 8);
    assert.equal(c.rag, 'green');
  });
});
