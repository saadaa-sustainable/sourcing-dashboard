import {test} from 'node:test';
import assert from 'node:assert/strict';
import {poBoardStage, poGrnReceiptIndex, hasPoGrnReceipt} from './po-board';
const po = {status:'approved' as const,po_issued_at:'2026-10-24',easycom_po_no:'EE-1',po_ref_num:'REF-1'};
test('receiving matches positive GRN by PO number OR reference', () => {
  for (const receipt of [
    {po_number:'EE-1',po_ref_num:'OTHER',received_quantity:1},
    {po_number:'OTHER',po_ref_num:'REF-1',received_quantity:'0.5'},
  ]) assert.equal(poBoardStage(po,hasPoGrnReceipt(po,poGrnReceiptIndex([receipt]))),'receiving');
});
test('zero, negative, unrelated and blank GRNs cannot establish receiving', () => {
  for (const receipt of [
    {po_number:'EE-1',po_ref_num:'REF-1',received_quantity:0},
    {po_number:'EE-1',po_ref_num:'REF-1',received_quantity:-1},
    {po_number:'EE-1',po_ref_num:'REF-1',received_quantity:null},
    {po_number:'EE-2',po_ref_num:'REF-2',received_quantity:5},
    {po_number:'',po_ref_num:null,received_quantity:5},
  ]) assert.equal(hasPoGrnReceipt(po,poGrnReceiptIndex([receipt])),false);
  assert.equal(hasPoGrnReceipt({easycom_po_no:'',po_ref_num:' '},poGrnReceiptIndex([{po_number:'',po_ref_num:' ',received_quantity:1}])),false);
});
test('reference-only mapping and historical receipts support receiving', () => {
  const mapped = {...po,easycom_po_no:null,po_issued_at:null};
  const receipts=Array.from({length:1501},(_,i)=>({po_number:'OTHER',po_ref_num:i===1500?'REF-1':'OTHER',received_quantity:1}));
  assert.equal(poBoardStage(mapped,hasPoGrnReceipt(mapped,poGrnReceiptIndex(receipts))),'receiving');
  assert.equal(poBoardStage(mapped,false),'on-easycom');
});
test('manual delivery date no longer starts receiving; workflow statuses retained', () => {
  assert.equal(poBoardStage({...po,first_actual_delivery_date:'2026-10-24'},false),'on-easycom');
  for(const [status,stage] of [['draft','draft'],['rework','rework'],['submitted','pending'],['pending_l2','pending'],['rejected',null]] as const) {
    assert.equal(poBoardStage({...po,status},true),stage);
  }
  assert.equal(poBoardStage({...po,easycom_po_no:null,po_ref_num:null,po_issued_at:null},false),'approved');
});
