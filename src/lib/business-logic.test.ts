import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { ageingBucket, buildTrackerRows, buildVendorRollups, deriveTnaStage, isHighRiskPo, vendorBucket } from './business-logic';
import { sheetDate } from './sheet-values';
import type { PendingPo, TnaRecord } from './types';

const base: PendingPo = { po_number:'1',po_created_date:null,po_date:null,item_price:100,po_id:'1',sku:'A',product_description:null,cp_id:'1',po_detail_id:'1',original_quantity:10,pending_quantity:10,size:'M',po_status:'Approved',vendor_name:'Vendor',vendor_code:'V1',expected_delivery_date:'2026-07-20',po_ref_num:'PO-1',product_variant:'RED',product_code:'P1',pending_qty_actual:10,po_type:'JOB',match_flag:true };
const tna: TnaRecord = { po_no:'PO-1',po_issued_date:null,po_qty:10,pp_sample_tna_date:null,pp_sample_actual_date:'2026-01-01',pp_sample_delay_days:0,gpt_tna_date:null,gpt_actual_date:null,gpt_delay_days:0,cutting_tna_date:null,cutting_actual_date_first:null,cutting_delay_days:0,in_line_tna_date:null,in_line_actual_date:null,in_line_qc_delay_days:0 };

describe('sourcing business rules', () => {
  it('buckets only labels containing woven as Woven', () => { assert.equal(vendorBucket('Premium Woven Unit'),'Woven'); assert.equal(vendorBucket('Knitted'),'Knit'); assert.equal(vendorBucket(null),'Knit'); });
  it('treats overdue zero-GRN rows as high risk', () => { assert.equal(isHighRiskPo({...base,expected_delivery_date:'2026-07-01'},new Date('2026-07-15T00:00:00Z')),true); assert.equal(isHighRiskPo({...base,pending_quantity:5},new Date('2026-07-15T00:00:00Z')),false); });
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
  it('groups by PO reference and product code and counts distinct variants', () => {
    const rows=buildTrackerRows([base,{...base,po_detail_id:'2',sku:'B',product_variant:'BLUE',pending_qty_actual:5},{...base,po_detail_id:'3',sku:'C',product_variant:'BLUE',pending_qty_actual:2}],[],[],[tna],new Date('2026-07-15T00:00:00Z'));
    assert.equal(rows.length,1); assert.equal(rows[0].variantCount,2); assert.equal(rows[0].pendingQty,17); assert.equal(rows[0].stage,'GPT Pending');
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
  it('still counts a split PO once per vendor and flags it delayed if any line is overdue', () => {
    const overdue={...base,po_detail_id:'A',expected_delivery_date:'2026-06-01',pending_qty_actual:4};
    const upcoming={...base,po_detail_id:'B',expected_delivery_date:'2026-07-31',pending_qty_actual:6};
    const [vendor]=buildVendorRollups([overdue,upcoming],[],[],[tna],new Date('2026-07-15T00:00:00Z'));
    assert.equal(vendor.openPoCount,1); assert.equal(vendor.delayedPoCount,1); assert.equal(vendor.openQty,10);
  });
});
