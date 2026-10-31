import { test } from 'node:test';
import assert from 'node:assert/strict';
import { historyPerformance, historyCapacity, type ReceiptLine, type HistoryOrderLine } from './vendor-history-analytics';
import { DEFAULT_CAPACITY_RULES } from './business-logic';
const line = (id: string, po: string, qty = 100, product = 'P1'): HistoryOrderLine => ({ po_detail_id: id, po_ref_num: po, po_number: null, product_code: product, original_qty: qty, expected_delivery_date: '2026-10-10' });
const receipt = (id: string, po: string, qty: number, actual = '2026-10-10'): ReceiptLine => ({ row_key: id, po_detail_id: 'L1', po_ref_num: po, po_number: null, po_original_quantity: 100, grn_receive_quantity: qty, last_grn_date: actual, expected_delivery_date: '2026-10-10' });
test('multiple GRNs and duplicate rows do not duplicate PO ordered quantities', () => {
 const a = receipt('G1', 'A', 40); const b = receipt('G2', 'A', 60);
 const p = historyPerformance([a,b,a], [line('L1','A')], new Map(), 'P1');
 assert.deepEqual(p.all, {pos:1,datedPos:1,otif:100,onTime:100,fill:100,delay:0}); assert.deepEqual(p.same,p.all);
});
test('unreceived lines count against fill; same product is exact, commitments take precedence', () => {
 const p = historyPerformance([receipt('1','A',100,'2026-10-12'), receipt('2','B',50)], [line('1','A'),line('2','A'),line('3','B',50,'P10')], new Map([['A','2026-10-13']]), 'P1');
 assert.equal(p.all.otif,50); assert.equal(p.all.onTime,100); assert.equal(p.same.pos,1); assert.equal(p.same.fill,0);
});
test('no dates excluded from timing, average delay includes zero for on-time', () => {
 const r = receipt('1','A',100); r.expected_delivery_date=null;
 const l=line('1','A'); l.expected_delivery_date=null;
 const p=historyPerformance([r,receipt('2','B',100,'2026-10-14'),receipt('3','C',100)], [l,line('2','B'),line('3','C')],new Map());
 assert.equal(p.all.pos,3);assert.equal(p.all.datedPos,2);assert.equal(p.all.delay,2);assert.equal(p.all.onTime,50);
 assert.equal(historyPerformance([],[],new Map()).all.otif,null);
});
const good = { pos:2,datedPos:2,otif:100,onTime:100,fill:100,delay:0 };
const now=Date.parse('2026-10-30T12:00:00Z');
const input={machines:10,karigar:10,vendorType:'job_work',inProcessQty:100,reportDate:'2026-10-30',poQty:100};
test('capacity recommendation uses shared model, quantity and headroom days',()=>{
 const c=historyCapacity(input,DEFAULT_CAPACITY_RULES,good,undefined,now);
 assert.equal(c.recommendation,'Capacity available');assert.equal(c.daysRemaining,Math.round(c.available!/(c.capacityPerMonth/30)*10)/10);
 assert.equal(historyCapacity({...input,poQty:c.available!+1},DEFAULT_CAPACITY_RULES,good,undefined,now).recommendation,'Hold: insufficient capacity');
 assert.equal(historyCapacity({...input,poQty:c.available!},DEFAULT_CAPACITY_RULES,good,undefined,now).recommendation,'Capacity available');
});
test('missing/stale report, unknown quantity and poor history never produce a clear recommendation',()=>{
 assert.equal(historyCapacity({...input,karigar:null},DEFAULT_CAPACITY_RULES,good,undefined,now).recommendation,'Check data before issuing');
 for(const change of [{reportDate:'2026-10-01'},{poQty:null}]) assert.equal(historyCapacity({...input,...change},DEFAULT_CAPACITY_RULES,good,undefined,now).recommendation,'Review before issuing');
 assert.equal(historyCapacity(input,DEFAULT_CAPACITY_RULES,{...good,otif:50},undefined,now).recommendation,'Review before issuing');
 assert.equal(historyCapacity(input,DEFAULT_CAPACITY_RULES,good,{...good,otif:50},now).recommendation,'Review before issuing');
});
