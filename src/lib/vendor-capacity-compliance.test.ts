import test from 'node:test';
import assert from 'node:assert/strict';
import { buildComplianceMonth, visibleComplianceRows, completeHistoryStart, complianceTotals, type ComplianceInput, type ComplianceMaster } from './vendor-capacity-compliance';
const master = (code = 'V1'): ComplianceMaster => ({ code, name: code, merchant: 'Owner', onboarding: null, isActive: true, status: 'active', fallbackActive: true });
const fixture = (extra: Partial<ComplianceInput> = {}): ComplianceInput => ({ masters: [master()], changes: [], updates: [], coverageStart: '2026-10-05', now: '2026-10-24T12:00:00Z', ...extra });
const row = (input: ComplianceInput) => buildComplianceMonth(input, '2026-10-01').rows[0];
test('completed-week score excludes running week and counts repeated saves once', () => {
  const r = row(fixture({ updates: [{code:'V1',at:'2026-10-06T00:00:00Z'}, {code:'v1',at:'2026-10-07T00:00:00Z'}, {code:'V1',at:'2026-10-20T00:00:00Z'}] }));
  assert.equal(r.completed, 2); assert.equal(r.updated, 1); assert.equal(r.score, 50); assert.equal(r.currentWeek, 'updated'); assert.equal(r.overdue, true);
});
test('four completed October weeks with three updates score 75%', () => {
  const r = row(fixture({ now:'2026-11-02T06:00:00Z', updates: ['05','12','19'].map(d=>({code:'V1',at:`2026-10-${d}T06:00:00Z`})) }));
  assert.equal(r.completed,4); assert.equal(r.score,75);
});
test('IST Sunday cutoff assigns next Monday exactly at 18:30 UTC', () => {
  const r = row(fixture({updates:[{code:'V1',at:'2026-10-11T18:29:59Z'}, {code:'V1',at:'2026-10-11T18:30:00Z'}]}));
  assert.equal(r.updated,2); assert.equal(r.score,100); assert.equal(r.currentWeek,'due');
});
test('unknown early history is excluded, never treated as a miss', () => {
  const r = row(fixture({coverageStart:'2026-10-19'}));
  assert.equal(r.completed,0); assert.equal(r.score,null); assert.equal(r.unknown,2); assert.equal(r.missedWeeks,null); assert.equal(r.overdue,false);
});
test('no audit history does not manufacture a 0% score', () => {
  const r = row(fixture({coverageStart:null})); assert.equal(r.score,null); assert.equal(r.currentWeek,'due');
});
test('history begins at first full week, respecting exact IST midnight', () => {
  assert.equal(completeHistoryStart('2026-10-12T12:57:09Z'),'2026-10-19');
  assert.equal(completeHistoryStart('2026-10-11T18:30:00Z'),'2026-10-12');
  assert.equal(completeHistoryStart(null),null);
});
test('midweek onboarding does not create a partial-week obligation', () => {
  const r=row(fixture({masters:[{...master(),onboarding:'2026-10-08'}]}));
  assert.equal(r.weeks[0].status,'not-required'); assert.equal(r.completed,1);
});
test('vendor created midweek is not scored for earlier weeks', () => {
  const r=row(fixture({changes:[{code:'V1',at:'2026-10-14T06:00:00Z',before:null,after:{vendor_code:'V1',ee_status:'active',is_active:true}}]}));
  assert.equal(r.completed,0); assert.equal(r.currentWeek,'due');
});
test('historical inactivity and reactivation are reconstructed from audits', () => {
  const r=row(fixture({changes:[{code:'V1',at:'2026-10-14T06:00:00Z',before:{ee_status:'inactive',is_active:false},after:{ee_status:'active',is_active:true}}]}));
  assert.equal(r.weeks[0].status,'not-required'); assert.equal(r.weeks[1].status,'not-required'); assert.equal(r.currentWeek,'due');
});
test('inactive interval inside a week excludes that week even after reactivation', () => {
  const r=row(fixture({changes:[{code:'V1',at:'2026-10-07T06:00:00Z',before:{ee_status:'active',is_active:true},after:{ee_status:'inactive',is_active:false}},{code:'V1',at:'2026-10-08T06:00:00Z',before:{ee_status:'inactive',is_active:false},after:{ee_status:'active',is_active:true}}]}));
  assert.equal(r.weeks[0].status,'not-required'); assert.equal(r.completed,1);
});
test('deboarding excludes its partial week and later weeks', () => {
  const r=row(fixture({masters:[{...master(),deboardedAt:'2026-10-14T06:00:00Z'}]}));
  assert.equal(r.completed,1); assert.equal(r.currentWeek,'not-required'); assert.equal(r.overdue,false);
});
test('missing EasyEcom status does not override source-active eligibility', () => {
  const r=row(fixture({masters:[{...master(),status:null}]}));
  assert.equal(r.completed,2); assert.equal(r.unknown,0); assert.equal(r.currentWeek,'due');
  assert.equal(r.vendorStatus,'active');
});
test('missed streak crosses months and shows a lower bound at coverage boundary', () => {
  const r=row(fixture({now:'2026-11-02T06:00:00Z'})); assert.equal(r.missedWeeks,4); assert.equal(r.streakPartial,true);
});
test('update breaks a missed streak and future updates cannot count', () => {
  const r=row(fixture({updates:[{code:'V1',at:'2026-10-06T00:00:00Z'},{code:'V1',at:'2026-10-26T06:00:00Z'}]}));
  assert.equal(r.missedWeeks,1); assert.equal(r.streakPartial,false); assert.equal(r.lastUpdated,'2026-10-06T00:00:00Z'); assert.equal(r.currentWeek,'due');
});
test('overall score weights vendor-week opportunities, not vendor percentages', () => {
  const report=buildComplianceMonth(fixture({masters:[master('A'),{...master('B'),onboarding:'2026-10-12'}],updates:[{code:'A',at:'2026-10-06T00:00:00Z'},{code:'A',at:'2026-10-13T00:00:00Z'}]}),'2026-10-01');
  const total=complianceTotals(report.rows); assert.equal(total.completed,3); assert.equal(total.updated,2); assert.equal(total.score,66.7);
});
test('no eligible vendors yields unavailable coverage, not 100%', () => {
  const total=complianceTotals([]); assert.equal(total.currentPct,null); assert.equal(total.score,null);
});
test('invalid reporting months are rejected', () => { assert.throws(()=>buildComplianceMonth(fixture(),'2026-13-01')); });

test('inactive source rows do not enter current coverage even with an active EasyEcom status', () => {
  const report=buildComplianceMonth(fixture({masters:[{...master(),isActive:false}]}),'2026-10-01');
  assert.equal(report.rows[0].vendorStatus,'inactive'); assert.equal(visibleComplianceRows(report).length,0); assert.equal(complianceTotals(report.rows).currentEligible,0);
});
test('source deactivation is reconstructed historically, not applied retroactively', () => {
  const r=row(fixture({masters:[{...master(),isActive:false}],changes:[{code:'V1',at:'2026-10-20T06:00:00Z',before:{ee_status:'active',is_active:true},after:{ee_status:'active',is_active:false}}]}));
  assert.equal(r.completed,2); assert.equal(r.currentWeek,'not-required'); assert.equal(r.overdue,false);
});

test('week becomes scored only after Sunday ends in IST', () => {
  const updates=[{code:'V1',at:'2026-10-20T06:00:00Z'}];
  assert.equal(row(fixture({coverageStart:'2026-10-19',updates,now:'2026-10-25T18:29:59Z'})).score,null);
  assert.equal(row(fixture({coverageStart:'2026-10-19',updates,now:'2026-10-25T18:30:00Z'})).score,100);
});
test('cross-month week belongs to the month of its Monday', () => {
  const report=buildComplianceMonth(fixture({now:'2026-11-01T06:00:00Z'}),'2026-11-01');
  assert.equal(report.rows[0].completed,0); assert.equal(report.rows[0].weeks.length,0);
});

test('inactive vendor remains visible when last update is in current IST week', () => {
  const report=buildComplianceMonth(fixture({masters:[{...master(),isActive:false}],updates:[{code:'V1',at:'2026-10-18T18:30:00Z'}]}),'2026-10-01');
  assert.equal(visibleComplianceRows(report).length,1); assert.equal(report.rows[0].vendorStatus,'inactive');
  assert.equal(report.rows[0].currentWeek,'not-required');
});
test('inactive vendor with update before the current week is excluded from list', () => {
  const report=buildComplianceMonth(fixture({masters:[{...master(),isActive:false,status:'inactive'}],updates:[{code:'V1',at:'2026-10-18T18:29:59Z'}]}),'2026-10-01');
  assert.equal(visibleComplianceRows(report).length,0);
});
test('inactive vendor with no update or future-only update is excluded', () => {
  for (const updates of [[],[{code:'V1',at:'2026-10-26T06:00:00Z'}]]) {
    const report=buildComplianceMonth(fixture({masters:[{...master(),isActive:false}],updates}),'2026-10-01');
    assert.equal(visibleComplianceRows(report).length,0);
  }
});
test('active vendor remains visible even without an update or full-week eligibility', () => {
  const report=buildComplianceMonth(fixture({masters:[{...master(),onboarding:'2026-10-23'}]}),'2026-10-01');
  assert.equal(visibleComplianceRows(report).length,1); assert.equal(report.rows[0].vendorStatus,'active');
  assert.equal(report.rows[0].currentWeek,'not-required');
});
test('hiding inactive vendor does not remove historical eligible weeks from score', () => {
  const report=buildComplianceMonth(fixture({masters:[{...master(),isActive:false}],changes:[{code:'V1',at:'2026-10-20T06:00:00Z',before:{ee_status:'active',is_active:true},after:{ee_status:'active',is_active:false}}],updates:[{code:'V1',at:'2026-10-13T06:00:00Z'}]}),'2026-10-01');
  assert.equal(visibleComplianceRows(report).length,0); assert.equal(complianceTotals(report.rows).score,50);
});

test('source-active flag overrides inactive EasyEcom and missing fallback status', () => {
  const report=buildComplianceMonth(fixture({masters:[{...master(),code:'FLR',isActive:true,status:'inactive',fallbackActive:false}]}),'2026-10-01');
  assert.equal(report.rows[0].vendorStatus,'active'); assert.equal(report.rows[0].currentWeek,'due');
  assert.equal(visibleComplianceRows(report).length,1);
});
