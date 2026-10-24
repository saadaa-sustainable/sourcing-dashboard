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
await db.exec(await readFile(new URL('../supabase/migrations/20261022183000_inward_plan_v2_product_planning.sql',import.meta.url),'utf8'));
await db.exec(await readFile(new URL('../supabase/migrations/20261023090000_inward_plan_v2_approve_with_edits.sql',import.meta.url),'utf8'));

const header={title:'Pending product plan',period_kind:'monthly',period_start:'2099-01-01'};
const line={planning_level:'product',po_number:'PO-1',product_code:'SD',expected_date:'2099-01-03',inward_qty:'150',cost_per_piece:'25',remarks:''};
const get=async id=>(await q('select * from public.sd_inward_plan_v2 where id=$1',[id]))[0];
async function pending() {
 await as('owner@saadaa.in');
 const id=(await q('select public.sd_inward_v2_save($1,$2,null) as id',[JSON.stringify(header),JSON.stringify([line])]))[0].id;
 await q("select public.sd_inward_v2_decide($1,'submit','',$2)",[id,(await get(id)).updated_at]);
 return {id,line:(await q('select * from public.sd_inward_plan_v2_line where plan_id=$1',[id]))[0]};
}
const first=await pending();
let h=await get(first.id);
const payload={...header,id:first.id,title:'Admin corrected',remarks:'Corrected plan'};
const edited={...line,id:first.line.id,inward_qty:'240',cost_per_piece:'26',expected_date:'2099-01-04',remarks:'Corrected quantity'};
for (const who of ['owner@saadaa.in','other@saadaa.in','viewer@saadaa.in']) {
 await as(who);
 await deny('select public.sd_inward_v2_approve_with_edits($1,$2,$3,$4)',[JSON.stringify(payload),JSON.stringify([edited]),'Reviewed',h.updated_at]);
}
await as('admin@saadaa.in');
const snapshot=async()=>JSON.stringify((await q("select jsonb_build_object('header',(select to_jsonb(h) from public.sd_inward_plan_v2 h where id=$1),'lines',(select jsonb_agg(to_jsonb(l) order by id) from public.sd_inward_plan_v2_line l where plan_id=$1),'history',(select jsonb_agg(to_jsonb(a) order by id) from public.sd_inward_plan_v2_approval_history a where plan_id=$1)) as data",[first.id]))[0].data);
const before=await snapshot();
await deny('select public.sd_inward_v2_approve_with_edits($1,$2,$3,$4)',[JSON.stringify(payload),JSON.stringify([{...edited,inward_qty:'301'}]),'Too much',h.updated_at]);
ok((await snapshot())===before);
await deny('select public.sd_inward_v2_approve_with_edits($1,$2,$3,$4)',[JSON.stringify(payload),JSON.stringify([]),'Empty',h.updated_at]);
ok((await snapshot())===before);
await deny('select public.sd_inward_v2_approve_with_edits($1,$2,$3,$4)',[JSON.stringify(payload),JSON.stringify([edited]),'Stale',new Date(0)]);
await deny('select public.sd_inward_v2_approve_with_edits($1,$2,$3,$4)',[JSON.stringify(payload),JSON.stringify([edited]),'x'.repeat(4001),h.updated_at]);
await deny('select public.sd_inward_v2_approve_with_edits($1,$2,$3,$4)',[JSON.stringify(header),JSON.stringify([edited]),'',h.updated_at]);
ok((await snapshot())===before);
const approved=(await q('select public.sd_inward_v2_approve_with_edits($1,$2,$3,$4) as id',[JSON.stringify(payload),JSON.stringify([edited]),'Admin confirmed',h.updated_at]))[0].id;
ok(approved===first.id);
h=await get(first.id);
ok(h.status==='approved'&&h.title==='Admin corrected'&&h.created_by==='owner@saadaa.in'&&h.approved_by==='admin@saadaa.in');
ok(h.decision_notes==='Admin confirmed');
const saved=(await q('select * from public.sd_inward_plan_v2_line where id=$1',[first.line.id]))[0];
ok(Number(saved.inward_qty)===240&&Number(saved.cost_per_piece)===26&&saved.remarks==='Corrected quantity'&&saved.sku===null);
ok((await q("select * from public.sd_inward_plan_v2_approval_history where record_id=$1 and after_row->>'inward_qty'='240.000'",[first.line.id])).length>0 || (await q("select * from public.sd_inward_plan_v2_approval_history where record_id=$1 and (after_row->>'inward_qty')::numeric=240",[first.line.id])).length>0);
await deny('select public.sd_inward_v2_approve_with_edits($1,$2,$3,$4)',[JSON.stringify(payload),JSON.stringify([edited]),'',h.updated_at]);
await deny('update public.sd_inward_plan_v2_line set inward_qty=1 where id=$1',[first.line.id]);
// Failed foreign-line edit cannot partially modify a pending plan.
const second=await pending();await as('admin@saadaa.in');
const oldSecond=await get(second.id);
await deny('select public.sd_inward_v2_approve_with_edits($1,$2,$3,$4)',[JSON.stringify({...header,id:second.id,title:'Should roll back'}),JSON.stringify([edited]),'',oldSecond.updated_at]);
ok((await get(second.id)).title===oldSecond.title&&(await get(second.id)).status==='pending_l2');
await db.exec('reset role');
ok((await q("select has_function_privilege('anon','public.sd_inward_v2_approve_with_edits(jsonb,jsonb,text,timestamp with time zone)','execute') as allowed"))[0].allowed===false);
ok((await q("select prosecdef from pg_proc where oid='public.sd_inward_v2_approve_with_edits(jsonb,jsonb,text,timestamp with time zone)'::regprocedure"))[0].prosecdef===false);
await db.close();console.log('PASS: '+checks+' atomic approve-with-edits database assertions.');
