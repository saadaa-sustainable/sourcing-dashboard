import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';

// Isolated Postgres fixture; no credentials, network, or production writes.
const { PGlite } = await import(pathToFileURL(process.argv[2]).href);
const db = new PGlite();
await db.exec(`
create role anon; create role authenticated; create role service_role;
create type sd_status as enum ('draft','submitted','pending_l2','approved','rework','rejected');
create table sd_buying_plan(id bigint primary key, plan_month date, plan_type text default 'fg',
 status sd_status, submitted_at timestamptz, approved_at timestamptz, approved_by text);
create table sd_buying_plan_line(id bigint primary key, plan_id bigint references sd_buying_plan,
 line_status sd_status, job_work_qty numeric default 0, fob_qty numeric default 0,
 efob_qty numeric default 0, standard_value numeric default 123, rework_notes text);
create table sd_analytics_rule(rule_key text primary key, value numeric);
create table sd_approval_log(entity_type text,entity_id text,entity_label text,
 from_status sd_status,to_status sd_status,actor_email text,notes text);
create schema cron;
create table test_clock(value timestamptz);
insert into test_clock values ('2026-10-07T18:29:59.999Z');
create function test_now() returns timestamptz language sql stable as $$ select value from public.test_clock $$;
create table cron.jobs(name text, schedule text, command text);
create function cron.schedule(text,text,text) returns bigint language sql as
$$ insert into cron.jobs values ($1,$2,$3) returning 1::bigint $$;
grant select,insert,update on all tables in schema public to authenticated;
`);
const migration = await readFile(new URL('../supabase/migrations/20261024172816_buying_plan_auto_approval.sql', import.meta.url), 'utf8');
// Replace only the clock in the fixture to test both sides of the exact boundary.
await db.exec(migration.replaceAll('transaction_timestamp()', 'public.test_now()'));
const q = async (sql) => (await db.query(sql)).rows;
const run = async () => Number((await q('select sd_plan_workflow.auto_approve() as n'))[0].n);
assert.equal((await q('select schedule from cron.jobs'))[0].schedule, '* * * * *');
await db.exec(`
insert into sd_buying_plan(id,plan_month,status,submitted_at,plan_type) values
 (1,'2000-01-01','pending_l2',now(),'fg'),(2,'2000-01-01','submitted',now(),'material'),
 (3,'2000-01-01','draft',null,'fg'),(4,'2000-01-01','rework',now(),'fg'),
 (5,'2000-01-01','rejected',now(),'fg'),(6,'2000-01-01','approved',now(),'fg'),
 (7,'2099-01-01','pending_l2',now(),'fg'),(8,'2000-01-01','pending_l2',null,'fg'),
 (9,'2000-01-01','pending_l2',now(),'fg'),(10,'2000-01-01','pending_l2',now(),'fg'),
 (11,'2000-01-01','pending_l2',now(),'fg');
insert into sd_buying_plan_line(id,plan_id,line_status,job_work_qty)
 select id,id,status,10 from sd_buying_plan where id<>9;
insert into sd_buying_plan_line(id,plan_id,line_status,job_work_qty) values
 (12,1,'approved',10),(13,1,'rejected',10),(14,1,null,0),(15,10,'rework',10);
update sd_buying_plan_line set line_status='rejected' where plan_id=11;
`);
assert.equal(await run(), 2);
assert.equal(await run(), 0, 'retry is idempotent');
assert.deepEqual(await q('select id from sd_buying_plan where auto_approved order by id'), [{ id: 1 }, { id: 2 }]);
assert.deepEqual(await q('select id from sd_buying_plan_line where auto_approved order by id'), [{ id: 1 }, { id: 2 }]);
assert.equal((await q('select count(*)::int as n from sd_approval_log'))[0].n, 2);
assert.match((await q('select notes from sd_approval_log limit 1'))[0].notes, /Auto-Approved via Workflow/);
assert.equal((await q('select standard_value from sd_buying_plan_line where id=1'))[0].standard_value, '123');
// No API row cap: the SQL job must process more than 1,000 pending lines.
await db.exec(`insert into sd_buying_plan values (20,'2000-01-01','fg','pending_l2',now(),null,null,false);
insert into sd_buying_plan_line(id,plan_id,line_status,job_work_qty)
select x,20,'pending_l2',1 from generate_series(100,1600) x;`);
assert.equal(await run(), 1);
assert.equal((await q('select count(*)::int as n from sd_buying_plan_line where plan_id=20 and auto_approved'))[0].n, 1501);
// Deadline day is inclusive through EOD IST; custom Rules Master days use the same boundary.
for (const day of [1, 7, 28]) {
  const [r] = await q(`select
    '2026-10-01'::date + ${day} as next_day,
    (('2026-10-01'::date+${day})::timestamp at time zone 'Asia/Kolkata') as cutoff`);
  assert.equal(new Date(r.cutoff).toISOString(), `2026-10-${String(day).padStart(2,'0')}T18:30:00.000Z`);
}
// Reopening clears the provenance; a subsequent manual approval stays manual.
await db.exec("update sd_buying_plan set status='rework' where id=1; update sd_buying_plan set status='approved' where id=1;");
assert.equal((await q('select auto_approved from sd_buying_plan where id=1'))[0].auto_approved, false);
await db.exec("update sd_buying_plan_line set line_status='pending_l2' where id=1;");
assert.equal((await q('select auto_approved from sd_buying_plan_line where id=1'))[0].auto_approved, false);
await db.exec('set role authenticated');
await assert.rejects(() => db.exec('select sd_plan_workflow.auto_approve()'), /permission denied/);
await assert.rejects(() => db.exec('update sd_buying_plan set auto_approved=true where id=1'), /Only the workflow/);
await db.exec('reset role');
await db.exec(`insert into sd_buying_plan values (25,'2026-10-01','material','pending_l2',now(),null,null,false);
insert into sd_buying_plan_line(id,plan_id,line_status,job_work_qty) values (25,25,'pending_l2',1);`);
assert.equal(await run(), 0, '7th EOD has not expired yet');
await db.exec("update test_clock set value='2026-10-07T18:30:00Z'");
assert.equal(await run(), 1, 'approve at midnight IST after the deadline');
assert.equal(new Date((await q('select approved_at from sd_buying_plan where id=25'))[0].approved_at).toISOString(), '2026-10-07T18:30:00.000Z');
await db.exec(`insert into sd_analytics_rule values ('plan_approval_deadline_day',10);
insert into sd_buying_plan values (26,'2026-10-01','fg','submitted',now(),null,null,false);
insert into sd_buying_plan_line(id,plan_id,line_status,job_work_qty) values (26,26,'submitted',1);`);
assert.equal(await run(), 0, 'custom deadline overrides default');
await db.exec("update test_clock set value='2026-10-10T18:30:00Z'");
assert.equal(await run(), 1, 'custom deadline expires at IST midnight');
// Audit failure rolls back the complete transition and all line updates.
await db.exec(`insert into sd_buying_plan values (30,'2000-01-01','fg','pending_l2',now(),null,null,false);
insert into sd_buying_plan_line(id,plan_id,line_status,job_work_qty) values (30,30,'pending_l2',1);
alter table sd_approval_log add constraint fail_audit check (entity_id<>'30');`);
await assert.rejects(run, /fail_audit/);
assert.equal((await q('select status from sd_buying_plan where id=30'))[0].status, 'pending_l2');
assert.equal((await q('select line_status from sd_buying_plan_line where id=30'))[0].line_status, 'pending_l2');
// Revised policy is applied after the original deployed migration, just as in production.
const periodMigration = await readFile(new URL('../supabase/migrations/20261024175235_buying_plan_period_auto_approval.sql', import.meta.url), 'utf8');
await db.exec(periodMigration.replaceAll('transaction_timestamp()', 'public.test_now()'));
await db.exec(`alter table sd_approval_log drop constraint fail_audit;
truncate sd_buying_plan_line,sd_buying_plan,sd_approval_log;
delete from sd_analytics_rule;
update test_clock set value='2026-10-07T18:29:59.999Z';
insert into sd_buying_plan(id,plan_month,status,submitted_at,plan_type) values
 (101,'2026-09-01','pending_l2',null,'fg'),
 (102,'2026-09-01','draft',null,'material'),
 (103,'2026-09-01','draft',null,'fg'),
 (104,'2026-09-01','rework',now(),'fg'),
 (105,'2026-09-01','rejected',now(),'fg'),
 (106,'2026-10-01','pending_l2',now(),'fg'),
 (107,'2026-10-01','draft',null,'material'),
 (108,'2026-11-01','pending_l2',now(),'fg'),
 (109,'2026-09-01','pending_l2',now(),'fg');
insert into sd_buying_plan_line(id,plan_id,line_status,job_work_qty) values
 (101,101,null,20),(102,101,'pending_l2',10),(103,101,'approved',5),
 (104,101,'rejected',5),(105,101,null,0),
 (106,102,'draft',10),(107,104,'rework',10),(108,105,'rejected',10),
 (109,106,null,10),(110,107,'draft',10),(111,108,'pending_l2',10),
 (112,109,'rework',10);`);
assert.equal(await run(), 3, 'past pending, draft and empty unstarted plans close automatically');
assert.deepEqual(await q('select id from sd_buying_plan where auto_approved order by id'), [{ id:101 },{ id:102 },{ id:103 }]);
assert.deepEqual(await q('select id from sd_buying_plan_line where auto_approved order by id'), [{ id:101 },{ id:102 },{ id:106 }]);
assert.equal((await q('select line_status from sd_buying_plan_line where id=104'))[0].line_status, 'rejected');
assert.match((await q("select notes from sd_approval_log where entity_id='103'"))[0].notes, /past-month pending \/ not-started/);
assert.equal(await run(), 0, 'period closure retries are idempotent');
await db.exec("update test_clock set value='2026-10-07T18:30:00Z'");
assert.equal(await run(), 1, 'current pending plan expires at TAT; current draft and future pending remain');
assert.equal((await q('select status from sd_buying_plan where id=107'))[0].status, 'draft');
assert.equal((await q('select status from sd_buying_plan where id=108'))[0].status, 'pending_l2');
await db.exec("update test_clock set value='2026-10-31T18:29:59.999Z'");
assert.equal(await run(), 0, 'current draft stays draft through month end');
await db.exec("update test_clock set value='2026-10-31T18:30:00Z'");
assert.equal(await run(), 1, 'unstarted draft closes at IST month rollover, before the new month TAT');
assert.equal((await q('select status from sd_buying_plan where id=107'))[0].status, 'approved');
assert.equal((await q('select status from sd_buying_plan where id=108'))[0].status, 'pending_l2');
await db.close();
console.log('Buying Plan auto-approval database checks passed.');
