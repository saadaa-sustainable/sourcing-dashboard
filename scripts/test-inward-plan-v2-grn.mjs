import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
// node scripts/test-inward-plan-v2-grn.mjs <pglite/dist/index.js>
// Isolated in-memory database; reuses only the reviewed workflow suite SQL fixture.
const { PGlite } = await import(pathToFileURL(process.argv[2]).href);
const db = new PGlite();
const previous = await readFile(new URL('./test-inward-plan-v2-workflow.mjs',import.meta.url),'utf8');
const fixture = previous.match(/await db.exec\(\x60([\s\S]*?)\x60\);/)[1];
await db.exec(fixture);
await db.exec(`
insert into public.sd_po_master_raw values
('11','PO-1','REF-1','Approved','SD','SKU','SKU_S','S','V1','Vendor',100,25,null),
('12','PO-1','REF-1','Approved','SD','SKU','SKU_M','M','V1','Vendor',100,25,null),
('13','PO-1','REF-1','Approved','SD','SKU','SKU_S','M','V1','Vendor',100,25,null);
create table public.sd_ee_grn (
 grn_detail_id bigint primary key,grn_id bigint, purchase_order_detail_id bigint,
 po_number text,po_ref_num text,sku text,grn_created_at date,received_quantity numeric,
 synced_at timestamptz not null default now()
);
create view public.sd_ee_grn_saadaa with(security_invoker=true) as select * from public.sd_ee_grn;
grant select on public.sd_ee_grn,public.sd_ee_grn_saadaa to authenticated;
insert into public.sd_ee_grn(grn_detail_id,grn_id,purchase_order_detail_id,po_number,sku,grn_created_at,received_quantity) values
(9007199254740993,501,11,'PO-1','SKU_S','2026-10-05',6),
(102,502,12,'PO-1','SKU_M','2026-10-05',6),
(103,503,13,'PO-1','SKU_S','2026-10-05',6),
(104,504,11,'WRONG-PO','SKU_S','2026-10-05',6),
(105,505,11,'PO-1','SKU_S','2026-10-01',6),
(106,506,11,'PO-1','SKU_S','2026-10-06',10);
`);
const legacySnapshot = async () => (await db.query(`
select jsonb_build_object(
 'po',(select jsonb_agg(to_jsonb(p) order by po_detail_id) from public.sd_po_master_raw p),
 'grn',(select jsonb_agg(to_jsonb(g) order by grn_detail_id) from public.sd_ee_grn g),
 'views',(select jsonb_agg(to_jsonb(v) order by viewname) from pg_views v
   where schemaname='public' and viewname in ('sd_po_filtered','sd_ee_grn_saadaa')),
 'columns',(select jsonb_agg(to_jsonb(c) order by table_name,ordinal_position) from information_schema.columns c
   where table_schema='public' and table_name in ('sd_po_master_raw','sd_ee_grn'))
) as snapshot
`)).rows[0].snapshot;
const legacyBefore = await legacySnapshot();
for (const file of ['20261022115557_inward_plan_v2.sql','20261022115605_inward_plan_v2_workflow.sql','20261022115611_inward_plan_v2_grn_analytics.sql'])
 await db.exec(await readFile(new URL('../supabase/migrations/'+file,import.meta.url),'utf8'));
if (process.env.V2_PRODUCT_MIGRATION === 'true') {
 await db.exec(await readFile(new URL('../supabase/migrations/20261022183000_inward_plan_v2_product_planning.sql',import.meta.url),'utf8'));
}
let checks=0;
const q=async(sql,args=[]) => (await db.query(sql,args)).rows;
const ok=value => {assert.ok(value);checks++;};
const deny=async(sql,args=[]) => {await assert.rejects(()=>db.query(sql,args));checks++;};
async function as(email) {
 await db.exec('reset role');
 await q("select set_config('request.jwt.claims',$1,false)",[JSON.stringify({sub:'00000000-0000-4000-8000-000000000001',email,role:'authenticated'})]);
 await db.exec('set role authenticated');
}
async function makeLine(title,kind='monthly',detail='11') {
 const start=kind==='monthly'?'2099-01-01':'2099-01-05'; // Monday checked by DB below if used
 const plan=(await q('select public.sd_inward_v2_save($1::jsonb,$2::jsonb,null) as id',[
  JSON.stringify({title,period_kind:kind,period_start:start}),
  JSON.stringify([{po_detail_id:detail,expected_date:start,inward_qty:'10',cost_per_piece:'25'}])
 ]))[0].id;
 return (await q('select * from public.sd_inward_plan_v2_line where plan_id=$1',[plan]))[0];
}
const tracker=async id => (await q('select * from public.sd_grn_delay_tracker_v2 where id=$1',[id]))[0];
async function report(line,quantity=5) {
 return (await q("select public.sd_inward_v2_report_grn($1,$2,'2026-10-04','Not posted',null,'',null) as id",[line.id,quantity]))[0].id;
}
await as('owner@saadaa.in');
ok((await q("select grn_detail_id from public.sd_inward_v2_system_grn where grn_detail_id='9007199254740993'"))[0].grn_detail_id==='9007199254740993');
ok((await q("select * from public.sd_inward_v2_system_grn where grn_detail_id='104'")).length===0);
const line=await makeLine('First');
const t=await report(line,5);
await deny("select public.sd_inward_v2_reconcile_grn($1,'102',1,$2)",[t,(await tracker(t)).updated_at]);
await deny("select public.sd_inward_v2_reconcile_grn($1,'103',1,$2)",[t,(await tracker(t)).updated_at]);
await deny("select public.sd_inward_v2_reconcile_grn($1,'104',1,$2)",[t,(await tracker(t)).updated_at]);
await deny("select public.sd_inward_v2_reconcile_grn($1,'105',1,$2)",[t,(await tracker(t)).updated_at]);
await deny("select public.sd_inward_v2_reconcile_grn($1,'missing',1,$2)",[t,(await tracker(t)).updated_at]);
const oldVersion=(await tracker(t)).updated_at;
const first=(await q("select public.sd_inward_v2_reconcile_grn($1,'9007199254740993',3,$2) as id",[t,oldVersion]))[0].id;
ok((await q("select quantity,grn_detail_id from public.sd_inward_v2_reconciliations where id=$1",[first]))[0].grn_detail_id==='9007199254740993');
ok((await tracker(t)).status==='open');
// Review every tracker mutation as a non-owner and viewer, not just reconciliation.
for (const email of ['other@saadaa.in','viewer@saadaa.in']) {
 await as(email);
 await deny("select public.sd_inward_v2_report_grn($1,5,'2026-10-04','',null,'',$2)",[line.id,(await tracker(t)).updated_at]);
 await deny("select public.sd_inward_v2_reverse_grn($1,'Unauthorized',$2)",[first,(await tracker(t)).updated_at]);
}
await as('owner@saadaa.in');

ok((await q("select jsonb_typeof(after_row->'grn_detail_id') as kind from public.sd_inward_plan_v2_approval_history where record_id=$1 and entity='grn_reconciliation'",[first]))[0].kind==='string');
await deny("select public.sd_inward_v2_reconcile_grn($1,'106',1,$2)",[t,oldVersion]);
await deny("select public.sd_inward_v2_reconcile_grn($1,'106',3,$2)",[t,(await tracker(t)).updated_at]);
await deny("select public.sd_inward_v2_report_grn($1,2,'2026-10-04','',null,'',$2)",[line.id,(await tracker(t)).updated_at]);
await deny("select public.sd_inward_v2_report_grn($1,5,'2026-10-07','',null,'',$2)",[line.id,(await tracker(t)).updated_at]);
await deny('update public.sd_inward_v2_grn_reconciliation set quantity=1 where id=$1',[first]);
await deny('delete from public.sd_inward_v2_grn_reconciliation where id=$1',[first]);
await deny('delete from public.sd_grn_delay_tracker_v2 where id=$1',[t]);
await deny('update public.sd_inward_plan_v2_line set po_detail_id=\'12\' where id=$1',[line.id]);
await as('other@saadaa.in');
await deny("select public.sd_inward_v2_reconcile_grn($1,'106',1,$2)",[t,(await tracker(t)).updated_at]);
await deny("select public.sd_inward_v2_reverse_grn($1,'Wrong owner',$2)",[first,(await tracker(t)).updated_at]);
await as('viewer@saadaa.in');
await deny("select public.sd_inward_v2_reconcile_grn($1,'106',1,$2)",[t,(await tracker(t)).updated_at]);
await as('owner@saadaa.in');
const otherLine=await makeLine('Second','weekly');
const otherTracker=await report(otherLine,5);
await deny("select public.sd_inward_v2_reconcile_grn($1,'9007199254740993',4,$2)",[otherTracker,(await tracker(otherTracker)).updated_at]);
const second=(await q("select public.sd_inward_v2_reconcile_grn($1,'9007199254740993',3,$2) as id",[otherTracker,(await tracker(otherTracker)).updated_at]))[0].id;
await deny("select public.sd_inward_v2_reconcile_grn($1,'9007199254740993',1,$2)",[otherTracker,(await tracker(otherTracker)).updated_at]);
await deny("select public.sd_inward_v2_reverse_grn($1,'',$2)",[first,(await tracker(t)).updated_at]);
await q("select public.sd_inward_v2_reverse_grn($1,'Wrong reference allocation',$2)",[first,(await tracker(t)).updated_at]);
ok((await q('select reversed_by from public.sd_inward_v2_grn_reconciliation where id=$1',[first]))[0].reversed_by==='owner@saadaa.in');
await deny("select public.sd_inward_v2_reverse_grn($1,'Again',$2)",[first,(await tracker(t)).updated_at]);
await q("select public.sd_inward_v2_reconcile_grn($1,'106',5,$2)",[t,(await tracker(t)).updated_at]);
ok((await tracker(t)).status==='resolved');
await q("select public.sd_inward_v2_reverse_grn($1,'Correct report',$2)",[second,(await tracker(otherTracker)).updated_at]);
await q("delete from public.sd_grn_delay_tracker_v2 where id=$1",[otherTracker]);
ok((await q('select * from public.sd_inward_v2_grn_reconciliation where id=$1',[second])).length===1);
ok((await q("select * from public.sd_inward_plan_v2_approval_history where entity='grn_reconciliation' and operation='UPDATE'")).length===2);
await deny('delete from public.sd_inward_plan_v2_approval_history');
ok(Number((await q("select sum(received_qty) as qty from public.sd_inward_v2_system_grn where po_detail_id='11'"))[0].qty)===22);
await q("select public.sd_inward_v2_report_grn($1,12,'2026-10-04','Over-receipt',null,'',$2)",[line.id,(await tracker(t)).updated_at]);
ok(Number((await tracker(t)).reported_qty)===12 && (await tracker(t)).status==='open');
await q('update public.sd_inward_plan_v2_line set inward_qty=4 where id=$1',[line.id]);
ok(Number((await q('select inward_qty from public.sd_inward_plan_v2_line where id=$1',[line.id]))[0].inward_qty)===4);
await db.exec('reset role');
await q("insert into public.sd_custom_role values (1,array['/buying-plan'])");
await q("insert into public.sd_user_role values ('owner@saadaa.in',1)");
await as('owner@saadaa.in');
ok((await q('select * from public.sd_inward_v2_system_grn')).length===0);
ok((await q('select * from public.sd_inward_v2_reconciliations')).length===0);
await db.exec('reset role');
await db.exec('set role anon');
await deny('select * from public.sd_inward_v2_system_grn');
await deny('select * from public.sd_inward_v2_reconciliations');
// No source rows, source columns or legacy views changed during migration/workflows.
await db.exec('reset role');
assert.deepEqual(await legacySnapshot(),legacyBefore); checks++;
ok((await q("select count(*)::int as n from pg_class where relnamespace='public'::regnamespace and relname in ('sd_inward_plan_v2','sd_inward_plan_v2_line','sd_inward_plan_v2_approval_history','sd_grn_delay_tracker_v2','sd_inward_v2_grn_reconciliation') and relrowsecurity"))[0].n===5);
// A user with no V2 page access cannot invoke any mutation entry point.
await as('owner@saadaa.in');
const blocked = [
 ["select public.sd_inward_v2_save($1::jsonb,'[]'::jsonb,null)",[JSON.stringify({title:'Denied',period_kind:'monthly',period_start:'2099-01-01'})]],
 ["select public.sd_inward_v2_decide($1,'submit','',$2)",[line.plan_id,new Date()]],
 ["select public.sd_inward_v2_report_grn($1,1,'2026-10-04','',null,'',null)",[line.id]],
 ["select public.sd_inward_v2_reconcile_grn($1,'106',1,null)",[t]],
 ["select public.sd_inward_v2_reverse_grn($1,'Denied',null)",[first]],
];
for (const [sql,args] of blocked) await deny(sql,args);
await db.exec('reset role');
await db.exec('set role anon');
for (const [sql,args] of blocked) await deny(sql,args);
await db.close();
console.log('PASS: '+checks+' exact-reference, quantity, authorization, reversal and audit assertions.');
