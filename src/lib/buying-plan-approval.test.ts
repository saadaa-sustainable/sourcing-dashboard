import {test} from 'node:test';
import assert from 'node:assert/strict';
import {canDecideBuyingPlan,planApprovalStatus,frozenPlanValue,pricePlanLine} from './buying-plan-approval';
const rule={l1_email:'l1@saadaa.in',l2_email:'l2@saadaa.in',max_value:100000};
test('value threshold is inclusive in INR, not quantity',()=>{
 assert.equal(planApprovalStatus(100000,rule),'submitted');assert.equal(planApprovalStatus(100000.01,rule),'pending_l2');assert.equal(planApprovalStatus(99999.99,rule),'submitted');
 for(const value of [null,NaN,Infinity,-1])assert.equal(planApprovalStatus(value,rule),'pending_l2');
});
test('mapped L2 can decide either pending level, any value including unknown',()=>{
 for(const status of ['submitted','pending_l2'] as const)for(const value of [0,100000,1e9,null])assert.ok(canDecideBuyingPlan({email:'L2@SAADAA.IN',role:'team'},status,rule,value));
});
test('L1 limited by whole-plan value; admin role alone cannot bypass configured matrix',()=>{
 assert.ok(canDecideBuyingPlan({email:rule.l1_email,role:'team'},'pending_l2',rule,100000));
 assert.equal(canDecideBuyingPlan({email:rule.l1_email,role:'admin'},'submitted',rule,100000.01),false);
 assert.equal(canDecideBuyingPlan({email:'other@saadaa.in',role:'admin'},'submitted',rule,1),false);
 assert.equal(canDecideBuyingPlan({email:rule.l1_email,role:'team'},'submitted',rule,null),false);
});
test('approved/draft/rework/rejected and disabled viewer retain locks',()=>{
 for(const status of ['approved','draft','rework','rejected'] as const)assert.equal(canDecideBuyingPlan({email:rule.l2_email,role:'admin'},status,rule,1),false);
 assert.equal(canDecideBuyingPlan({email:rule.l2_email,role:'viewer'},'pending_l2',rule,1),false);
});
test('unconfigured retains legacy role route',()=>{
 assert.ok(canDecideBuyingPlan({email:'team@saadaa.in',role:'team'},'submitted',null,null));
 assert.equal(canDecideBuyingPlan({email:'team@saadaa.in',role:'team'},'pending_l2',null,null),false);
});
test('frozen whole-plan value counts active lines once, missing costs go to L2',()=>{
 const line={job_work_qty:10,standard_value:12.34};
 assert.equal(frozenPlanValue([line,{...line,standard_value:0.01},{...line,line_status:'rejected',standard_value:999}]),12.35);
 assert.equal(frozenPlanValue([line,{job_work_qty:1,standard_value:null}]),null);
 assert.equal(frozenPlanValue([{job_work_qty:0,standard_value:null}]),0);
});

test('missing lane prices cannot reduce the routed plan value',()=>{
 assert.equal(pricePlanLine({job_work_qty:1,fob_qty:1},{job:10,fob:0,efob:0}),null);
 assert.equal(pricePlanLine({job_work_qty:1},{job:10,fob:0,efob:0}),10);
 assert.equal(pricePlanLine({efob_qty:10},{job:1,fob:1},true),0);
});
