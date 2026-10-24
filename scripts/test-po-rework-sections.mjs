import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
const { PGlite } = await import(pathToFileURL(process.argv[2]).href);
const db = new PGlite();
await db.exec(`
create role anon; create role authenticated;
create table sd_po_approval (
 id bigint primary key, status text, rate numeric, cm_cost numeric, vendor_code text,
 product_code text, buying_plan_no text, po_qty numeric, tna_days_first_delivery int,
 critical_path_first_delivery date, tna_confirmed boolean default true,
 tna_confirmed_at timestamptz, tna_confirmed_by text, submitted_for_approval_at timestamptz,
 requested_total_days int, rejection_notes text, in_buying_plan boolean,
 plan_qty_at_submit numeric, submit_remark text
);
create table sd_po_approval_line (
 id bigint primary key, po_id bigint references sd_po_approval, qty numeric
);
insert into sd_po_approval(id,status,rate,po_qty,vendor_code) values
 (1,'submitted',10,100,'V1'),(2,'rework',10,100,'V2'),(3,'rework',10,100,'V3');
insert into sd_po_approval_line values (1,1,100),(2,2,100),(3,3,100);
`);
await db.exec(await readFile(new URL('../supabase/migrations/20261023171618_po_rework_sections.sql', import.meta.url),'utf8'));
let checks = 0;
async function ok(sql) { await db.exec(sql); checks++; }
async function denied(sql, pattern) { await assert.rejects(db.exec(sql), pattern); checks++; }
await ok("update sd_po_approval set status='rework',rework_sections=array['cost'] where id=1");
await ok('update sd_po_approval set rate=20 where id=1');
for (const change of ["vendor_code='V9'", "product_code='SD'", "buying_plan_no='2026-11'", 'po_qty=90', 'tna_days_first_delivery=10']) {
 await denied('update sd_po_approval set '+change+' where id=1', /Only sections/);
}
await denied("update sd_po_approval set rework_sections=array['sku'] where id=1", /cannot be changed/);
await denied('update sd_po_approval_line set qty=90 where id=1', /SKU quantities/);
await denied('delete from sd_po_approval_line where id=1', /SKU quantities/);
await denied('insert into sd_po_approval_line values(4,1,10)', /SKU quantities/);
await denied('update sd_po_approval_line set po_id=1 where id=2', /SKU quantities/);
// Legacy NULL remains unrestricted.
await ok("update sd_po_approval set vendor_code='LEGACY',rate=12 where id=2");
await ok('update sd_po_approval_line set qty=80 where id=2');
// Start a fresh scoped SKU rework from the queue.
await ok("update sd_po_approval set status='submitted' where id=3");
await ok("update sd_po_approval set status='rework',rework_sections=array['sku'] where id=3");
await ok('update sd_po_approval_line set qty=60 where id=3');
await ok('update sd_po_approval set po_qty=60 where id=3');
await denied('update sd_po_approval set rate=30 where id=3', /Only sections/);
assert.equal((await db.query('select tna_confirmed from sd_po_approval where id=3')).rows[0].tna_confirmed,false); checks++;
await ok("update sd_po_approval set status='submitted',submit_remark='Fixed' where id=1");
await ok("update sd_po_approval set vendor_code='PENDING' where id=1");
await ok("update sd_po_approval set status='rework',rework_sections=array['tna'] where id=1");
await ok('update sd_po_approval set tna_days_first_delivery=7 where id=1');
await denied('update sd_po_approval set rate=99 where id=1', /Only sections/);
await ok('update sd_po_approval set tna_confirmed=true where id=1');
assert.equal((await db.query('select tna_confirmed from sd_po_approval where id=1')).rows[0].tna_confirmed,false); checks++;
await denied("update sd_po_approval set rework_sections=array['bad'] where id=2", /check constraint/);
await denied("update sd_po_approval set rework_sections=array[]::text[] where id=2", /check constraint/);
// Multi-section rework permits both, never order metadata.
await ok("update sd_po_approval set status='submitted' where id=1");
await ok("update sd_po_approval set status='rework',rework_sections=array['cost','tna','sku'] where id=1");
await ok('update sd_po_approval set rate=25,tna_days_first_delivery=9,po_qty=120 where id=1');
await ok('update sd_po_approval_line set qty=120 where id=1');
await denied("update sd_po_approval set vendor_code='BAD' where id=1", /Only sections/);
console.log(checks+' database assertions passed');
await db.close();
