import assert from 'node:assert/strict';
import { test } from 'node:test';
import { calculateAnalytics, matchingGrns, reconciliationBalances, uniqueReceipts } from './analytics';
import type { GrnData, SystemGrn, DelayReport, Reconciliation } from './grn-types';
import type { Plan, PlanLine, PeriodKind } from './types';
const plan = (id: string, kind: PeriodKind = 'monthly', start = '2026-11-01') => ({
  id, status: 'approved', period_kind: kind, period_start: start,
} as Plan);
const line = (id: string, plan_id: string, inward_qty = 10, expected_date = '2026-11-04', extra: Partial<PlanLine> = {}) => ({
  id, plan_id, inward_qty, expected_date, po_detail_id: '11', po_number: 'PO-1', sku: 'SKU_S', size: 'S', ...extra,
} as PlanLine);
const grn = (id: string, received_on = '2026-11-05', received_qty = 4, extra: Partial<SystemGrn> = {}) => ({
  grn_detail_id: id, grn_id: '500', po_detail_id: '11', po_number: 'PO-1', sku: 'SKU_S', size: 'S',
  po_ref_num: null, received_on, received_qty, synced_at: '2026-11-06T00:00:00Z', ...extra,
});
const empty = (extra: Partial<GrnData> = {}): GrnData => ({
  plans: [plan('m')], lines: [line('a', 'm')], reports: [], reconciliations: [], receipts: [], ...extra,
});
const report = (id = 't', qty = 5) => ({
  id, line_id: 'a', plan_id: 'm', reported_qty: qty, received_on: '2026-11-04',
} as DelayReport);
const reconciliation = (extra: Partial<Reconciliation> = {}) => ({
  id: 'r', tracker_id: 't', plan_id: 'm', line_id: 'a', grn_detail_id: '1', quantity: 2, grn_id: '500',
  po_detail_id: '11', po_number: 'PO-1', sku: 'SKU_S', size: 'S', system_received_on: '2026-11-05',
  system_qty: 4, system_synced_at: '2026-11-06T00:00:00Z', created_at: '2026-11-06T00:00:00Z',
  created_by: 'owner@saadaa.in', reversed_at: null, reversed_by: null, reversal_reason: null, ...extra,
} as Reconciliation);
test('weekly and monthly baselines never combine planned or actual quantities', () => {
  const data = empty({ plans: [plan('m'), plan('w', 'weekly', '2026-11-02')],
    lines: [line('a','m'), line('b','w')], receipts: [grn('1')] });
  const monthly = calculateAnalytics(data, 'monthly', '2026-11-01', '2026-11-30');
  const weekly = calculateAnalytics(data, 'weekly', '2026-11-02', '2026-11-30');
  assert.equal(monthly.planned, 10); assert.equal(weekly.planned, 10);
  assert.equal(monthly.actual, 4); assert.equal(weekly.actual, 4);
  assert.equal(monthly.achievement, 40);
});
test('multiple schedules/plans share a GRN once and FIFO assigns late quantities once', () => {
  const data = empty({ plans: [plan('m'),plan('m2')], lines: [line('a','m',3,'2026-11-03'),line('b','m2',7,'2026-11-06')],
    receipts: [grn('1','2026-11-05',4),grn('1','2026-11-05',4)] });
  const result = calculateAnalytics(data,'monthly','2026-11-01','2026-11-30');
  assert.equal(result.actual,4); assert.equal(result.late,3); assert.equal(result.shortfall,6);
});
test('exact PO detail, PO, SKU and size prevent loose PO attribution', () => {
  const receipts = [grn('1'),grn('2',undefined,8,{po_detail_id:'12'}),
    grn('3',undefined,8,{sku:'SKU_M'}),grn('4',undefined,8,{size:'M'}),grn('5',undefined,8,{po_number:'PO-2'})];
  const data = empty({receipts});
  assert.equal(calculateAnalytics(data,'monthly','2026-11-01','2026-11-30').actual,4);
  assert.deepEqual(matchingGrns(data.lines[0],'2026-11-04',receipts).map(r=>r.grn_detail_id),['1']);
});
test('unknown sizes are retained as unknown, not guessed or pooled with known sizes', () => {
  const data = empty({lines:[line('a','m',10,undefined,{size:null})],
    receipts:[grn('1',undefined,4,{size:null}),grn('2',undefined,9,{size:'S'})]});
  assert.equal(calculateAnalytics(data,'monthly','2026-11-01','2026-11-30').actual,4);
});
test('post-period late receipts do not inflate in-period actual or achievement', () => {
  const data = empty({receipts:[grn('1','2026-11-05',3),grn('2','2026-12-02',2)]});
  const result = calculateAnalytics(data,'monthly','2026-11-01','2026-12-04');
  assert.equal(result.actual,3); assert.equal(result.achievement,30);
  assert.equal(result.late,3); assert.equal(result.lateAfterPeriod,2); assert.equal(result.shortfall,7);
});
test('tracker reports and reconciliation never add to actuals; partial/reversed balances remain separate', () => {
  const data = empty({receipts:[grn('1')],reports:[report()],reconciliations:[reconciliation()]});
  let result=calculateAnalytics(data,'monthly','2026-11-01','2026-11-30');
  assert.equal(result.actual,4); assert.equal(result.awaiting,3);
  data.reconciliations[0].reversed_at='2026-11-07T00:00:00Z';
  result=calculateAnalytics(data,'monthly','2026-11-01','2026-11-30');
  assert.equal(result.actual,4); assert.equal(result.awaiting,5);
});
test('source reduction/deletion/identity drift restores awaiting quantities and emits warnings', () => {
  const data=empty({receipts:[grn('1',undefined,1)],reports:[report()],reconciliations:[reconciliation()]});
  let balance=reconciliationBalances(data);
  assert.equal(balance.awaiting.get('t'),4); assert.equal(balance.warnings.length,1);
  data.receipts=[]; balance=reconciliationBalances(data);
  assert.equal(balance.awaiting.get('t'),5); assert.equal(balance.warnings.length,1);
  data.receipts=[grn('1',undefined,4,{size:'M'})]; balance=reconciliationBalances(data);
  assert.equal(balance.awaiting.get('t'),5);
});
test('global reference capacity is shared across trackers, including alternative cadences', () => {
  const data=empty({lines:[line('a','m'),line('b','m')], receipts:[grn('1',undefined,3)],
    reports:[report(),{...report('t2'),line_id:'b'}],
    reconciliations:[reconciliation(),reconciliation({id:'r2',tracker_id:'t2',line_id:'b'})]});
  const balance=reconciliationBalances(data);
  assert.equal(balance.effective.get('t'),2); assert.equal(balance.effective.get('t2'),1);
  assert.equal(balance.awaiting.get('t2'),4); assert.equal(balance.warnings.length,1);
});
test('over-receipts can exceed 100 percent without offsetting another SKU shortfall', () => {
  const data=empty({lines:[line('a','m',10),line('b','m',10,undefined,{po_detail_id:'12',sku:'SKU_M',size:'M'})],
    receipts:[grn('1',undefined,30)]});
  const result=calculateAnalytics(data,'monthly','2026-11-01','2026-11-30');
  assert.equal(result.achievement,150); assert.equal(result.shortfall,10);
  assert.equal(result.rows.find(row => row.po_detail_id === '11')!.unallocated,20); assert.equal(result.late,10);
});
test('more than 1000 GRNs aggregate exactly, including fractional quantities', () => {
  const data=empty({lines:[line('a','m',200)],receipts:Array.from({length:1501},(_,i)=>grn(String(i+1),undefined,0.1))});
  const result=calculateAnalytics(data,'monthly','2026-11-01','2026-11-30');
  assert.equal(result.actual,150.1); assert.equal(result.shortfall,49.9); assert.equal(result.rows[0].references.length,1501);
});
test('unapproved baselines, future GRNs and pre-period receipts are excluded', () => {
  const data=empty({plans:[{...plan('m'),status:'draft'}],receipts:[grn('1')]});
  assert.equal(calculateAnalytics(data,'monthly','2026-11-01','2026-11-30').achievement,null);
  data.plans=[plan('m')]; data.receipts=[grn('1','2026-10-31'),grn('2','2026-12-01')];
  assert.equal(calculateAnalytics(data,'monthly','2026-11-01','2026-11-30').actual,0);
});
test('unsafe/malformed/conflicting source records fail loudly rather than display false zeros', () => {
  assert.throws(()=>uniqueReceipts([grn('1'),grn('1',undefined,9)]),/Conflicting/);
  assert.throws(()=>uniqueReceipts([grn('1','not-a-date')]),/missing/);
  assert.throws(()=>uniqueReceipts([grn('1',undefined,-1)]),/Invalid/);
  assert.throws(()=>uniqueReceipts([grn('1',undefined,Infinity)]),/Invalid/);
  assert.throws(()=>uniqueReceipts([grn('1',undefined,0.0001)]),/Invalid/);
});
test('bigint GRN detail references retain their exact text identity', () => {
  const refs=[grn('9007199254740992'),grn('9007199254740993')];
  assert.equal(uniqueReceipts(refs).length,2);
});

test('GRN header identity drift invalidates reconciliation and conflicting copies fail', () => {
 const data=empty({receipts:[grn('1',undefined,4,{grn_id:'501'})],reports:[report()],reconciliations:[reconciliation()]});
 const balance=reconciliationBalances(data);
 assert.equal(balance.awaiting.get('t'),5);
 assert.equal(balance.warnings.length,1);
 assert.throws(()=>uniqueReceipts([grn('1'),grn('1',undefined,4,{grn_id:'501'})]),/Conflicting/);
});
test('a cross-year weekly period includes January receipts only through Sunday', () => {
 const data=empty({plans:[plan('w','weekly','2026-12-28'),plan('m','monthly','2027-01-01')],
  lines:[line('a','w',10,'2027-01-01'),line('b','m',20,'2027-01-02')],
  receipts:[grn('1','2026-12-27',1),grn('2','2027-01-01',2),
   grn('3','2027-01-03',3),grn('4','2027-01-04',4)]});
 const week=calculateAnalytics(data,'weekly','2026-12-28','2027-01-05');
 assert.equal(week.end,'2027-01-03'); assert.equal(week.planned,10);
 assert.equal(week.actual,5); assert.equal(week.late,3); assert.equal(week.lateAfterPeriod,4);
 const month=calculateAnalytics(data,'monthly','2027-01-01','2027-01-05');
 assert.equal(month.planned,20); assert.equal(month.actual,9);
});


test('product plans total all source sizes once and exclude wrong PO/product', () => {
  const productLine = line('a', 'm', 10, undefined, {planning_level:'product', product_code:'SD',po_detail_id:null,sku:null,size:null});
  const receipts = [grn('1',undefined,3,{product_code:'SD'}), grn('2',undefined,4,{product_code:'SD',po_detail_id:'12',sku:'SKU_M',size:'M'}),
    grn('3',undefined,50,{product_code:'OTHER'}),grn('4',undefined,50,{product_code:'SD',po_number:'PO-OTHER'})];
  const result = calculateAnalytics(empty({lines:[productLine],receipts:[...receipts,receipts[0]]}), 'monthly','2026-11-01','2026-11-30');
  assert.equal(result.rows.length,1);assert.equal(result.actual,7);assert.equal(result.shortfall,3);assert.equal(result.late,7);
  assert.deepEqual(matchingGrns(productLine,null,receipts).map(row=>row.grn_detail_id),['1','2']);
});
test('product reconciliation accepts exact GRN snapshots of different sizes and rejects product drift', () => {
  const productLine=line('a','m',10,undefined,{planning_level:'product',product_code:'SD',po_detail_id:null,sku:null,size:null});
  const data=empty({lines:[productLine],reports:[report()],reconciliations:[reconciliation()],receipts:[grn('1',undefined,4,{product_code:'SD'})]});
  assert.equal(reconciliationBalances(data).awaiting.get('t'),3);
  data.receipts[0].product_code='OTHER';
  assert.equal(reconciliationBalances(data).awaiting.get('t'),5);
  assert.equal(reconciliationBalances(data).warnings.length,1);
});
test('legacy and product baselines share a receipt ledger within a cadence', () => {
  const data=empty({plans:[plan('m'),plan('old','monthly','2026-10-01')],
    lines:[line('a','m',10,undefined,{planning_level:'product',product_code:'SD',po_detail_id:null,sku:null,size:null}),
      line('old','old',2,'2026-10-03',{product_code:'SD'})],
    receipts:[grn('1','2026-11-05',5,{product_code:'SD'})]});
  const result=calculateAnalytics(data,'monthly','2026-11-01','2026-11-30');
  assert.equal(result.actual,5);assert.equal(result.late,5);assert.equal(result.rows.length,1);
});
