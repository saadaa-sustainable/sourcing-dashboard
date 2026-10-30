import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';

// Usage: node scripts/test-inward-plan-v2.mjs <path-to-pglite-dist-index.js>
// Uses an in-memory database only. No .env, credentials or network connection.
// Minimal dependencies reproduce the live role helpers inspected 2026-10-22;
// this is a migration/authorization test, not a replay of all legacy migrations.
const { PGlite } = await import(pathToFileURL(process.argv[2]).href);
const db = new PGlite();
await db.exec(`
create role anon; create role authenticated; create role service_role bypassrls;
create schema auth;
create function auth.jwt() returns jsonb language sql stable as
$$ select coalesce(nullif(current_setting('request.jwt.claims',true),''),'{}')::jsonb $$;
create function auth.uid() returns uuid language sql stable as
$$ select (auth.jwt()->>'sub')::uuid $$;
grant usage on schema auth to public;
grant execute on all functions in schema auth to public;
create type public.sd_role as enum ('viewer','team','admin');
create table public.sd_user(email text primary key, role public.sd_role, is_active boolean not null default true);
alter table public.sd_user enable row level security;
create function public.sd_is_saadaa() returns boolean language sql stable set search_path='' as
$$ select lower(coalesce(auth.jwt()->>'email','')) like '%@saadaa.in' $$;
create function public.sd_current_role() returns public.sd_role language sql stable security definer set search_path='' as
$$ select coalesce((select role from public.sd_user where email=lower(auth.jwt()->>'email') and is_active),'viewer'::public.sd_role) $$;
create policy users_read on public.sd_user for select to authenticated using(public.sd_is_saadaa());
grant select on public.sd_user to authenticated;
insert into public.sd_user(email,role,is_active) values
('owner@saadaa.in','team',true),('other@saadaa.in','team',true),
('admin@saadaa.in','admin',true),('viewer@saadaa.in','viewer',true),
('disabled@saadaa.in','admin',false),('outsider@example.com','admin',true);
-- Mimic permissive Supabase default grants to verify the migration revokes them.
alter default privileges in schema public grant all on tables to anon, authenticated;
alter default privileges in schema public grant all on sequences to anon, authenticated;
`);
await db.exec(await readFile(new URL('../supabase/migrations/20261022115557_inward_plan_v2.sql',import.meta.url),'utf8'));
let checks = 0;
const q = async (sql, params=[]) => (await db.query(sql,params)).rows;
const ok = (condition) => { assert.ok(condition); checks++; };
const deny = async (sql,params=[]) => {
  await assert.rejects(() => db.query(sql,params)); checks++;
};
const as = async (email,role='authenticated') => {
  await db.exec('reset role');
  await db.query("select set_config('request.jwt.claims',$1,false)",[JSON.stringify(
    email ? {sub:'00000000-0000-4000-8000-000000000001',email,role} : {role}
  )]);
  await db.exec('set role '+role);
};
const createPlan = async () => (await q(
  "insert into public.sd_inward_plan_v2(plan_month,title,created_by,updated_by) values ('2026-10-01','October','spoof','spoof') returning *"
))[0];
const addLine = async (plan) => (await q(
  "insert into public.sd_inward_plan_v2_line(plan_id,po_detail_id,po_number,product_code,sku,expected_date,inward_qty,created_by,updated_by) values ($1,'text-detail-1','PO-1','SD','SDWH_S','2026-10-23',10,'spoof','spoof') returning *",[plan]
))[0];
await as('owner@saadaa.in');
const p = await createPlan();
ok(p.created_by === 'owner@saadaa.in');
await deny("update public.sd_inward_plan_v2 set status='pending_l2' where id=$1",[p.id]);
const l = await addLine(p.id);
ok(l.created_by === 'owner@saadaa.in');
await deny("insert into public.sd_inward_plan_v2_line select * from public.sd_inward_plan_v2_line");
await deny("update public.sd_inward_plan_v2_line set inward_qty=-1 where id=$1",[l.id]);
await deny("update public.sd_inward_plan_v2_line set inward_qty='NaN' where id=$1",[l.id]);
await deny("update public.sd_inward_plan_v2_line set expected_date='2026-11-01' where id=$1",[l.id]);
await deny("update public.sd_inward_plan_v2 set plan_month='2026-11-01' where id=$1",[p.id]);
await deny("update public.sd_inward_plan_v2 set created_by='other@saadaa.in' where id=$1",[p.id]);
await q("update public.sd_inward_plan_v2 set status='pending_l2' where id=$1",[p.id]);
await q("update public.sd_inward_plan_v2_line set inward_qty=12,sku='SDWH_M',size='M' where id=$1",[l.id]);
ok((await q("select inward_qty from public.sd_inward_plan_v2_line where id=$1",[l.id]))[0].inward_qty==='12.000');
await deny("update public.sd_inward_plan_v2 set status='approved' where id=$1",[p.id]);
await as('other@saadaa.in');
ok((await q("update public.sd_inward_plan_v2 set title='stolen' where id=$1 returning id",[p.id])).length===0);
ok((await q("delete from public.sd_inward_plan_v2_line where id=$1 returning id",[l.id])).length===0);
await deny("insert into public.sd_grn_delay_tracker_v2(line_id,created_by,updated_by) values ($1,'x','x')",[l.id]);
await as('viewer@saadaa.in');
ok((await q('select * from public.sd_inward_plan_v2')).length===1);
await deny("insert into public.sd_inward_plan_v2(plan_month,title,created_by,updated_by) values ('2026-10-01','x','x','x')");
for (const email of ['disabled@saadaa.in','unknown@saadaa.in','outsider@example.com']) {
  await as(email);
  ok((await q('select * from public.sd_inward_plan_v2')).length===0);
  await deny("insert into public.sd_inward_plan_v2(plan_month,title,created_by,updated_by) values ('2026-10-01','x','x','x')");
}
await as(null,'anon');
await deny('select * from public.sd_inward_plan_v2');
await deny('truncate public.sd_inward_plan_v2_line cascade');
await as('admin@saadaa.in');
await deny("update public.sd_inward_plan_v2 set status='rework' where id=$1",[p.id]);
await q("update public.sd_inward_plan_v2 set status='approved' where id=$1",[p.id]);
ok((await q("select approved_by from public.sd_inward_plan_v2 where id=$1",[p.id]))[0].approved_by==='admin@saadaa.in');
for (const email of ['owner@saadaa.in','admin@saadaa.in']) {
  await as(email);
  await deny("update public.sd_inward_plan_v2_line set inward_qty=99 where id=$1",[l.id]);
  await deny("delete from public.sd_inward_plan_v2_line where id=$1",[l.id]);
  await deny("update public.sd_inward_plan_v2 set title='locked' where id=$1",[p.id]);
}
await as('owner@saadaa.in');
const tracker = (await q("insert into public.sd_grn_delay_tracker_v2(line_id,delay_reason,created_by,updated_by) values ($1,'Transport','x','x') returning *",[l.id]))[0];
await deny("update public.sd_grn_delay_tracker_v2 set status='resolved' where id=$1",[tracker.id]);
await q("update public.sd_grn_delay_tracker_v2 set status='resolved',received_on='2026-10-24' where id=$1",[tracker.id]);
await deny("insert into public.sd_inward_plan_v2_approval_history(plan_id,record_id,entity,operation,changed_by,after_row) values ($1,$1,'plan','INSERT','spoof','{}')",[p.id]);
await deny('delete from public.sd_inward_plan_v2_approval_history');
await deny('truncate public.sd_inward_plan_v2_approval_history');
await deny('select sd_inward_v2_private.guard()');
await as('admin@saadaa.in');
await q("update public.sd_inward_plan_v2 set status='rework',decision_notes='Fix quantity' where id=$1",[p.id]);
ok((await q("select revision,approved_at from public.sd_inward_plan_v2 where id=$1",[p.id]))[0].revision===2);
await as('owner@saadaa.in');
await q("update public.sd_inward_plan_v2_line set inward_qty=14 where id=$1",[l.id]);
ok((await q("select status from public.sd_inward_plan_v2 where id=$1",[p.id]))[0].status==='pending_l2');
await as('admin@saadaa.in');
await q("update public.sd_inward_plan_v2 set status='rejected',decision_notes='Wrong SKU' where id=$1",[p.id]);
await as('owner@saadaa.in');
await q("update public.sd_inward_plan_v2 set title='Corrected' where id=$1",[p.id]);
ok((await q("select status from public.sd_inward_plan_v2 where id=$1",[p.id]))[0].status==='pending_l2');
const p2 = await createPlan();
await deny("update public.sd_inward_plan_v2_line set plan_id=$1 where id=$2",[p2.id,l.id]);
await q("delete from public.sd_inward_plan_v2_line where id=$1",[l.id]);
ok((await q('select * from public.sd_grn_delay_tracker_v2')).length===0);
ok((await q("select * from public.sd_inward_plan_v2_approval_history where entity='grn_delay' and operation='DELETE' and before_row->>'delay_reason'='Transport'")).length===1);
// Empty rejected plans must accept a first replacement line and resubmit.
await as('admin@saadaa.in');
await q("update public.sd_inward_plan_v2 set status='rejected',decision_notes='Replace line' where id=$1",[p.id]);
await as('owner@saadaa.in');
await addLine(p.id);
ok((await q("select status from public.sd_inward_plan_v2 where id=$1",[p.id]))[0].status==='pending_l2');
ok((await q("select * from public.sd_inward_plan_v2_approval_history where entity='line' and operation='DELETE' and before_row->>'sku'='SDWH_M'")).length===1);
ok((await q("select * from public.sd_inward_plan_v2_approval_history where entity='plan' and to_status='approved'")).length===1);
await deny("delete from public.sd_inward_plan_v2 where id=$1",[p.id]);
await as(null,'service_role');
await deny("insert into public.sd_inward_plan_v2(plan_month,title,created_by,updated_by) values ('2026-10-01','x','x','x')");
await as('admin@saadaa.in');
await db.exec('reset role');
ok((await q("select count(*)::int as n from pg_class where relnamespace='public'::regnamespace and relname in ('sd_inward_plan_v2','sd_inward_plan_v2_line','sd_inward_plan_v2_approval_history','sd_grn_delay_tracker_v2') and relrowsecurity"))[0].n===4);
ok((await q("select has_table_privilege('authenticated','public.sd_inward_plan_v2_approval_history','insert') as allowed"))[0].allowed===false);
await db.close();
console.log('PASS: '+checks+' migration, lifecycle, constraints, grants and RLS assertions (local in-memory Postgres).');
