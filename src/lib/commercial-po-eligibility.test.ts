import {test} from 'node:test';
import assert from 'node:assert/strict';
import {isCommercialPoEligible} from './commercial-po-eligibility';
test('strict whole-date cutoff excludes all of 31 March and accepts 1 April',()=>{
 for(const po_date of ['2026-03-30','2026-03-31','2026-03-31T23:59:59',null,'invalid'])assert.equal(isCommercialPoEligible({po_date,po_status:'Approved'}),false);
 for(const po_date of ['2026-04-01','2026-04-01T00:00:00','2026-10-30'])assert.equal(isCommercialPoEligible({po_date,po_status:'Approved'}),true);
});
test('only Approved and Completed remain selectable',()=>{
 assert.ok(isCommercialPoEligible({po_date:'2026-04-01',po_status:'Completed'}));
 for(const po_status of ['Draft','Rejected',null])assert.equal(isCommercialPoEligible({po_date:'2026-04-01',po_status}),false);
});
