import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
// Run with: node scripts/test-inward-plan-v2-workflow.mjs <pglite/dist/index.js>
// In-memory Postgres only. Fixtures match inspected source column types.
const { PGlite } = await import(pathToFileURL(process.argv[2]).href);
const db = new PGlite();
await db.exec(`
create role anon; create role authenticated;
create schema auth;
create function auth.jwt() returns jsonb language sql stable as
$$ select coalesce(nullif(current_setting('request.jwt.claims',true),''),'{}')::jsonb $$;
create function auth.uid() returns uuid language sql stable as $$ select (auth.jwt()->>'sub')::uuid $$;
grant usage on schema auth to public;
grant execute on all functions in schema auth to public;
create type public.sd_role as enum ('viewer','team','admin');
create table public.sd_user(email text primary key,role public.sd_role,is_active boolean not null default true);
alter table public.sd_user enable row level security;
create function public.sd_is_saadaa() returns boolean language sql stable set search_path='' as
$$ select lower(coalesce(auth.jwt()->>'email','')) like '%@saadaa.in' $$;
create function public.sd_current_role() returns public.sd_role language sql stable security definer set search_path='' as
$$ select coalesce((select role from public.sd_user where email=lower(auth.jwt()->>'email') and is_active),'viewer'::public.sd_role) $$;
create policy users_read on public.sd_user for select to authenticated using(public.sd_is_saadaa());
grant select on public.sd_user to authenticated;
create table public.sd_custom_role(id bigint primary key,pages text[] not null);
create table public.sd_user_role(user_email text,role_id bigint,primary key(user_email,role_id));
grant select on public.sd_custom_role,public.sd_user_role to authenticated;
insert into public.sd_user(email,role) values
('owner@saadaa.in','team'),('other@saadaa.in','team'),('admin@saadaa.in','admin'),('viewer@saadaa.in','viewer');
create table public.sd_po_master_raw (
 po_detail_id text primary key,po_number text,po_ref_num text,po_status text,
 product_code text,product_variant text,sku text,size text,vendor_code text,vendor_name text,
 pending_qty numeric,item_price numeric,expected_delivery_date date
);
create view public.sd_po_filtered with(security_invoker=true) as select * from public.sd_po_master_raw;
grant select on public.sd_po_filtered,public.sd_po_master_raw to authenticated;
insert into public.sd_po_master_raw values
('detail-A','PO-A','FY26/PO-A','Approved','SD','SDWH','SDWH_S','S','V1','Real vendor',100,25,null),
('detail-B','PO-B','FY26/PO-B','Approved','SD','SDWH','SDWH_M','M','V1','Real vendor',100,30,null);
`);
for (const file of ['20261022115557_inward_plan_v2.sql','20261022115605_inward_plan_v2_workflow.sql'])
  await db.exec(await readFile(new URL('../supabase/migrations/'+file,import.meta.url),'utf8'));
if (process.env.V2_PRODUCT_MIGRATION === 'true') {
 await db.exec(`create table public.sd_ee_grn(grn_detail_id bigint primary key,grn_id bigint,purchase_order_detail_id bigint,po_number text,sku text,grn_created_at date,received_quantity numeric,synced_at timestamptz default now());
 create view public.sd_ee_grn_saadaa with(security_invoker=true) as select * from public.sd_ee_grn;
 grant select on public.sd_ee_grn,public.sd_ee_grn_saadaa to authenticated;`);
 await db.exec(await readFile(new URL('../supabase/migrations/20261022115611_inward_plan_v2_grn_analytics.sql',import.meta.url),'utf8'));
 await db.exec(await readFile(new URL('../supabase/migrations/20261022183000_inward_plan_v2_product_planning.sql',import.meta.url),'utf8'));
}
let checks = 0;
const q = async (sql,params=[]) => (await db.query(sql,params)).rows;
const ok = value => { assert.ok(value); checks++; };
const deny = async (sql,params=[]) => { await assert.rejects(() => db.query(sql,params)); checks++; };
async function as(email) {
  await db.exec('reset role');
  await db.query("select set_config('request.jwt.claims',$1,false)",[JSON.stringify({
    sub:'00000000-0000-4000-8000-000000000001',email,role:'authenticated',
  })]);
  await db.exec('set role authenticated');
}
async function save(header,lines,version=null) {
  return (await q('select public.sd_inward_v2_save($1::jsonb,$2::jsonb,$3::timestamptz) as id',
    [JSON.stringify(header),JSON.stringify(lines),version]))[0].id;
}
const get = async id => (await q('select * from public.sd_inward_plan_v2 where id=$1',[id]))[0];
const header = { title:'January',period_kind:'monthly',period_start:'2099-01-01',remarks:'' };
const line = {po_detail_id:'detail-A',expected_date:'2099-01-03',inward_qty:'20',cost_per_piece:'25',remarks:''};
await as('owner@saadaa.in');
const id = await save(header,[]);
ok((await get(id)).status==='draft');
ok(new Date((await get(id)).submission_deadline).toISOString()==='2099-01-02T18:30:00.000Z');
await deny('select public.sd_inward_v2_decide($1,\'submit\',\'\',$2)',[id,(await get(id)).updated_at]);
await save({...header,id},[line],(await get(id)).updated_at);
let lines = await q('select * from public.sd_inward_plan_v2_line where plan_id=$1',[id]);
ok(lines.length===1 && lines[0].vendor_name==='Real vendor' && lines[0].sku==='SDWH_S');
const version = (await get(id)).updated_at;
await save({...header,id,title:'Corrected'},[{...line,id:lines[0].id}],version);
await deny('select public.sd_inward_v2_save($1::jsonb,$2::jsonb,$3)',[JSON.stringify({...header,id}),JSON.stringify([line]),version]);
const beforeCount = (await q('select count(*)::int as n from public.sd_inward_plan_v2_approval_history'))[0].n;
await deny('select public.sd_inward_v2_save($1::jsonb,$2::jsonb,$3)',[
 JSON.stringify({...header,id,title:'Must roll back'}),JSON.stringify([{...line,po_detail_id:'missing'}]),(await get(id)).updated_at]);
ok((await get(id)).title==='Corrected');
ok((await q('select count(*)::int as n from public.sd_inward_plan_v2_approval_history'))[0].n===beforeCount);
await as('other@saadaa.in');
await deny('select public.sd_inward_v2_save($1::jsonb,$2::jsonb,$3)',[
 JSON.stringify({...header,id}),JSON.stringify([]),(await get(id)).updated_at]);
await deny("select public.sd_inward_v2_decide($1,'submit','',$2)",[id,(await get(id)).updated_at]);
await as('viewer@saadaa.in');
await deny('select public.sd_inward_v2_save($1::jsonb,$2::jsonb,null)',[JSON.stringify(header),'[]']);
await as('owner@saadaa.in');
// Validate all scheduled dates together against the pending quantity.
await save({...header,id},[{...line,id:lines[0].id,inward_qty:'70'},{...line,expected_date:'2099-01-04',inward_qty:'60'}],(await get(id)).updated_at);
await deny("select public.sd_inward_v2_decide($1,'submit','',$2)",[id,(await get(id)).updated_at]);
lines = await q('select * from public.sd_inward_plan_v2_line where plan_id=$1 order by expected_date',[id]);
await save({...header,id},[{...line,id:lines[0].id}],(await get(id)).updated_at);
await q("select public.sd_inward_v2_decide($1,'submit','',$2)",[id,(await get(id)).updated_at]);
ok((await get(id)).status==='pending_l2' && (await get(id)).submitted_at);
await deny("select public.sd_inward_v2_decide($1,'approve','',$2)",[id,(await get(id)).updated_at]);
await as('admin@saadaa.in');
await deny("select public.sd_inward_v2_decide($1,'rework','',$2)",[id,(await get(id)).updated_at]);
await q("select public.sd_inward_v2_decide($1,'rework','Fix date',$2)",[id,(await get(id)).updated_at]);
await as('owner@saadaa.in');
await save({...header,id},[{...line,id:lines[0].id,expected_date:'2099-01-05'}],(await get(id)).updated_at);
ok((await get(id)).status==='pending_l2');
// Approval revalidates current source data, not just submission-time snapshots.
await db.exec('reset role');
await q("update public.sd_po_master_raw set pending_qty=1 where po_detail_id='detail-A'");
await as('admin@saadaa.in');
await deny("select public.sd_inward_v2_decide($1,'approve','',$2)",[id,(await get(id)).updated_at]);
await db.exec('reset role');
await q("update public.sd_po_master_raw set pending_qty=100 where po_detail_id='detail-A'");
await as('admin@saadaa.in');
await q("select public.sd_inward_v2_decide($1,'approve','Checked source',$2)",[id,(await get(id)).updated_at]);
ok((await get(id)).status==='approved');
await deny('select public.sd_inward_v2_save($1::jsonb,$2::jsonb,$3)',[
 JSON.stringify({...header,id,title:'Locked'}),JSON.stringify([]),(await get(id)).updated_at]);
await q("select public.sd_inward_v2_decide($1,'reopen','Amend dates',$2)",[id,(await get(id)).updated_at]);
ok((await get(id)).revision===2);
await as('owner@saadaa.in');
// Select a future Monday whose week crosses a calendar-month boundary.
const monday = new Date('2099-01-01T00:00:00Z');
while (monday.getUTCDay()!==1 || monday.getUTCDate()<26) monday.setUTCDate(monday.getUTCDate()+1);
const sunday = new Date(monday); sunday.setUTCDate(sunday.getUTCDate()+6);
const weekly = {title:'Cross-month week',period_kind:'weekly',period_start:monday.toISOString().slice(0,10)};
const weekId = await save(weekly,[{...line,expected_date:sunday.toISOString().slice(0,10)}]);
ok(new Date((await get(weekId)).period_end).toISOString().slice(0,10)===sunday.toISOString().slice(0,10));
await q("select public.sd_inward_v2_decide($1,'submit','',$2)",[weekId,(await get(weekId)).updated_at]);
ok((await get(weekId)).status==='pending_l2');
// Changing a submitted plan's period cannot bypass that period's cutoff.
await deny('select public.sd_inward_v2_save($1::jsonb,$2::jsonb,$3)',[
 JSON.stringify({...weekly,id:weekId,period_start:'2001-01-01'}),
 JSON.stringify([{...line,expected_date:'2001-01-02'}]),(await get(weekId)).updated_at]);
ok(new Date((await get(weekId)).period_start).toISOString().slice(0,10)===weekly.period_start);

await deny('select public.sd_inward_v2_save($1::jsonb,$2::jsonb,null)',[
 JSON.stringify({...weekly,period_start:sunday.toISOString().slice(0,10)}),'[]']);
const expiredId = await save({...header,title:'Expired',period_start:'2001-01-01'},[{...line,expected_date:'2001-01-02'}]);
await deny("select public.sd_inward_v2_decide($1,'submit','',$2)",[expiredId,(await get(expiredId)).updated_at]);
ok((await get(expiredId)).status==='draft');
// Approved headers require an actual on-time submission, including upgraded rows.
await db.exec('reset role');
await db.exec('alter table public.sd_inward_plan_v2 disable trigger user');
await q("update public.sd_inward_plan_v2 set status='pending_l2',submitted_at=null where id=$1",[expiredId]);
await db.exec('alter table public.sd_inward_plan_v2 enable trigger user');
await as('admin@saadaa.in');
await deny("select public.sd_inward_v2_decide($1,'approve','',$2)",[expiredId,(await get(expiredId)).updated_at]);
await q("select public.sd_inward_v2_decide($1,'reject','Late plan',$2)",[expiredId,(await get(expiredId)).updated_at]);
await as('owner@saadaa.in');
const expiredLines = await q('select * from public.sd_inward_plan_v2_line where plan_id=$1',[expiredId]);
await deny('select public.sd_inward_v2_save($1::jsonb,$2::jsonb,$3)',[
 JSON.stringify({...header,id:expiredId,title:'Late resubmission',period_start:'2001-01-01'}),
 JSON.stringify([{...line,id:expiredLines[0].id,expected_date:'2001-01-02'}]),(await get(expiredId)).updated_at]);
ok((await get(expiredId)).status==='rejected');
await save({...header,id:expiredId,title:'Next period'},[{...line,id:expiredLines[0].id}],(await get(expiredId)).updated_at);
ok((await get(expiredId)).status==='pending_l2');
// Pending plans may remove their last line; approval then fails validation.
const currentLines = await q('select * from public.sd_inward_plan_v2_line where plan_id=$1',[expiredId]);
await q('delete from public.sd_inward_plan_v2_line where id=$1',[currentLines[0].id]);
ok((await q('select * from public.sd_inward_plan_v2_line where plan_id=$1',[expiredId])).length===0);
await as('admin@saadaa.in');
await deny("select public.sd_inward_v2_decide($1,'approve','',$2)",[expiredId,(await get(expiredId)).updated_at]);

// Page assignments restrict database access too.
await db.exec('reset role');
await q("insert into public.sd_custom_role values (1,array['/buying-plan'])");
await q("insert into public.sd_user_role values ('owner@saadaa.in',1)");
await as('owner@saadaa.in');
ok((await q('select * from public.sd_inward_plan_v2')).length===0);
await deny('select public.sd_inward_v2_save($1::jsonb,$2::jsonb,null)',[JSON.stringify(header),'[]']);
await db.exec('reset role');
await q("update public.sd_custom_role set pages=array['/inward-plan-v2'] where id=1");
await as('owner@saadaa.in');
ok((await q('select * from public.sd_inward_plan_v2')).length===3);
ok((await q("select * from public.sd_inward_plan_v2_approval_history where plan_id=$1 and to_status='approved'",[id])).length===1);
await deny('delete from public.sd_inward_plan_v2_approval_history');
// Review regressions: atomic date swaps and current source-size validation.
await as('owner@saadaa.in');
const swapId = await save({...header,title:'Atomic swap'},[
 {...line,expected_date:'2099-01-10'}, {...line,expected_date:'2099-01-11'}
]);
const swapLines = await q('select * from public.sd_inward_plan_v2_line where plan_id=$1 order by expected_date',[swapId]);
await save({...header,id:swapId},[
 {...line,id:swapLines[0].id,expected_date:'2099-01-11'},
 {...line,id:swapLines[1].id,expected_date:'2099-01-10'}
],(await get(swapId)).updated_at);
ok((await q('select expected_date::text as date from public.sd_inward_plan_v2_line where id=$1',[swapLines[0].id]))[0].date==='2099-01-11');
await deny('select public.sd_inward_v2_save($1::jsonb,$2::jsonb,$3)',[
 JSON.stringify({...header,id:swapId}),JSON.stringify(swapLines.map(l=>({...line,id:l.id}))),
 (await get(swapId)).updated_at]);
await q("select public.sd_inward_v2_decide($1,'submit','',$2)",[swapId,(await get(swapId)).updated_at]);
await db.exec('reset role');
await q("update public.sd_po_master_raw set size='CHANGED' where po_detail_id='detail-A'");
await as('admin@saadaa.in');
await deny("select public.sd_inward_v2_decide($1,'approve','',$2)",[swapId,(await get(swapId)).updated_at]);
await db.exec('reset role');
await q("update public.sd_po_master_raw set size='S' where po_detail_id='detail-A'");
await as('owner@saadaa.in');
await deny('select public.sd_inward_v2_save($1::jsonb,$2::jsonb,null)',[
 JSON.stringify({...header,period_start:'infinity'}),'[]']);
await db.close();
console.log('PASS: '+checks+' V2 atomic-save, source, weekly, deadline, authorization and review assertions.');
