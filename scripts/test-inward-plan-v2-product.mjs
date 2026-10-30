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
await as('owner@saadaa.in');
const preservedLegacy=await makeLine('Before product migration');
const legacyRowBefore=(await q('select to_jsonb(l) as row from public.sd_inward_plan_v2_line l where id=$1',[preservedLegacy.id]))[0].row;
const historyBefore=(await q('select count(*)::int as n from public.sd_inward_plan_v2_approval_history'))[0].n;
await db.exec('reset role');
await db.exec(await readFile(new URL('../supabase/migrations/20261022183000_inward_plan_v2_product_planning.sql',import.meta.url),'utf8'));
const preserved=(await q("select to_jsonb(l)-array['planning_level','product_schedule_key'] as row from public.sd_inward_plan_v2_line l where id=$1",[preservedLegacy.id]))[0].row;
assert.deepEqual(preserved,legacyRowBefore);checks++;
ok((await q('select count(*)::int as n from public.sd_inward_plan_v2_approval_history'))[0].n===historyBefore);


const header={title:'Product plan',period_kind:'monthly',period_start:'2099-01-01'};
const product={planning_level:'product',po_number:'PO-1',product_code:'SD',expected_date:'2099-01-03',inward_qty:'200',cost_per_piece:'25'};
async function save(header,lines,version=null) {
 return (await q('select public.sd_inward_v2_save($1::jsonb,$2::jsonb,$3) as id',[JSON.stringify(header),JSON.stringify(lines),version]))[0].id;
}
const get=async id=>(await q('select * from public.sd_inward_plan_v2 where id=$1',[id]))[0];
await as('owner@saadaa.in');
const id=await save(header,[{...product,sku:'SPOOF',vendor_name:'SPOOF',po_detail_id:'12'}]);
const line=(await q('select * from public.sd_inward_plan_v2_line where plan_id=$1',[id]))[0];
ok(line.planning_level==='product'&&line.sku===null&&line.po_detail_id===null&&line.product_variant===null&&line.size===null);
ok(Number(line.inward_qty)===200&&line.vendor_name==='Vendor');
ok((await q('select * from public.sd_inward_plan_v2_line where plan_id=$1',[id])).length===1);
ok(Number((await q("select pending_qty from public.sd_inward_v2_product_po where po_number='PO-1' and product_code='SD'"))[0].pending_qty)===300);
const version=(await get(id)).updated_at;
await deny('select public.sd_inward_v2_save($1,$2,$3)',[JSON.stringify({...header,id}),JSON.stringify([{...product,id:line.id}]),new Date(0)]);
await deny('select public.sd_inward_v2_save($1,$2,null)',[JSON.stringify(header),JSON.stringify([product,product])]);
await deny('select public.sd_inward_v2_save($1,$2,null)',[JSON.stringify(header),JSON.stringify([{...product,product_code:'WRONG'}])]);
const excess=await save(header,[{...product,inward_qty:'301'}]);
await deny("select public.sd_inward_v2_decide($1,'submit','',$2)",[excess,(await get(excess)).updated_at]);
const split=await save(header,[{...product,inward_qty:'160'},{...product,expected_date:'2099-01-04',inward_qty:'150'}]);
await deny("select public.sd_inward_v2_decide($1,'submit','',$2)",[split,(await get(split)).updated_at]);
await q("select public.sd_inward_v2_decide($1,'submit','',$2)",[id,version]);
ok((await get(id)).status==='pending_l2');
await save({...header,id,title:'Amended pending'},[{...product,id:line.id,inward_qty:'190'}],(await get(id)).updated_at);
ok((await get(id)).title==='Amended pending');
await as('other@saadaa.in');
await deny('select public.sd_inward_v2_save($1,$2,$3)',[JSON.stringify({...header,id}),JSON.stringify([{...product,id:line.id}]),(await get(id)).updated_at]);
await as('viewer@saadaa.in');
await deny('select public.sd_inward_v2_save($1,$2,null)',[JSON.stringify(header),JSON.stringify([product])]);
await as('admin@saadaa.in');
await q("select public.sd_inward_v2_decide($1,'approve','',$2)",[id,(await get(id)).updated_at]);
ok((await get(id)).status==='approved');
await deny('update public.sd_inward_plan_v2_line set inward_qty=2 where id=$1',[line.id]);
await deny('select public.sd_inward_v2_save($1,$2,$3)',[JSON.stringify({...header,id}),JSON.stringify([{...product,id:line.id}]),(await get(id)).updated_at]);
await q("select public.sd_inward_v2_decide($1,'reopen','Correction',$2)",[id,(await get(id)).updated_at]);
await as('owner@saadaa.in');
await save({...header,id},[{...product,id:line.id,inward_qty:'180'}],(await get(id)).updated_at);
ok((await get(id)).status==='pending_l2');
// Source revalidation at approval, not only at submit.
await db.exec('reset role');await q("update public.sd_po_master_raw set pending_qty=1 where po_number='PO-1'");
await as('admin@saadaa.in');
await deny("select public.sd_inward_v2_decide($1,'approve','',$2)",[id,(await get(id)).updated_at]);
await db.exec('reset role');await q("update public.sd_po_master_raw set pending_qty=100 where po_number='PO-1'");
await as('owner@saadaa.in');
// Product GRN report accepts different sizes of the same product, with global caps intact.
const t=await report(line,12);
await q("select public.sd_inward_v2_reconcile_grn($1,'9007199254740993',6,$2)",[t,(await tracker(t)).updated_at]);
await q("select public.sd_inward_v2_reconcile_grn($1,'102',6,$2)",[t,(await tracker(t)).updated_at]);
ok((await tracker(t)).status==='resolved');
await deny("select public.sd_inward_v2_reconcile_grn($1,'103',1,$2)",[t,(await tracker(t)).updated_at]);
await deny("update public.sd_inward_plan_v2_line set product_code='WRONG' where id=$1",[line.id]);
// Wrong product within same PO cannot reconcile.
await db.exec('reset role');await q("update public.sd_po_master_raw set product_code='OTHER' where po_detail_id='13'");
await as('owner@saadaa.in');
const separate=await save(header,[{...product,inward_qty:'10'}]);
const other=(await q('select * from public.sd_inward_plan_v2_line where plan_id=$1',[separate]))[0];
const t2=await report(other,10);
await deny("select public.sd_inward_v2_reconcile_grn($1,'103',1,$2)",[t2,(await tracker(t2)).updated_at]);
await deny("select public.sd_inward_v2_reconcile_grn($1,'9007199254740993',1,$2)",[t2,(await tracker(t2)).updated_at]);
await db.exec('reset role');await q("update public.sd_po_master_raw set product_code='SD' where po_detail_id='13'");
await as('owner@saadaa.in');
// Legacy saves still resolve exact detail and can have separate sizes per product/date.
const legacy=await save(header,[{po_detail_id:'11',expected_date:'2099-01-03',inward_qty:'2'},{po_detail_id:'12',expected_date:'2099-01-03',inward_qty:'3'}]);
ok((await q('select * from public.sd_inward_plan_v2_line where plan_id=$1',[legacy])).length===2);
ok((await q('select sku from public.sd_inward_plan_v2_line where plan_id=$1 order by po_detail_id',[legacy]))[0].sku==='SKU_S');
const mixed=await save(header,[product,{po_detail_id:'11',expected_date:'2099-01-04',inward_qty:'2'}]);
await deny("select public.sd_inward_v2_decide($1,'submit','',$2)",[mixed,(await get(mixed)).updated_at]);
await db.exec('reset role');
assert.deepEqual(await legacySnapshot(),legacyBefore);checks++;
await db.exec('set role anon');await deny('select * from public.sd_inward_v2_product_po');
await db.exec('reset role');
ok((await q("select reloptions from pg_class where relname='sd_inward_v2_product_po'"))[0].reloptions.includes('security_invoker=true'));
ok((await q("select has_function_privilege('anon','public.sd_inward_v2_save(jsonb,jsonb,timestamp with time zone)','execute') as allowed"))[0].allowed===false);
await db.close();console.log('PASS: '+checks+' product-level database assertions.');
