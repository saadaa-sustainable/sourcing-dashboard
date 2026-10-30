import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
// Isolated PostgreSQL fixtures; never connects to Supabase.
const { PGlite } = await import(pathToFileURL(process.argv[2]).href);
const db = new PGlite();
await db.exec(`create role anon; create role authenticated; create role service_role bypassrls;
 create type sd_status as enum ('draft','submitted','pending_l2','rework','rejected','approved');
 create function sd_is_saadaa() returns boolean language sql as $$select true$$;
 create function sd_can_write() returns boolean language sql as $$select true$$;
 create function sd_current_role() returns text language sql as $$select 'team'::text$$;
 create table sd_active_variants(product_code text);
 create table sd_material_standard_cost(id bigint);
 create schema storage; create table storage.buckets(id text primary key,name text,public boolean,file_size_limit bigint,allowed_mime_types text[]);
`);
for (const file of ['20260728_standard_cost.sql','20260811170000_standard_cost_detail.sql','20260811180000_cost_negotiation.sql','20260811200000_cost_fabric_link.sql','20260829120000_cmtp_components.sql','20260829180000_cost_line_consumption.sql','20260903090000_standard_cost_rate_history.sql','20260925100000_standard_cost_extra_fabric.sql','20260925140000_standard_cost_fabric_uom.sql','20261009100000_cost_documents.sql','20261009130000_cost_document_width_links.sql']) {
  await db.exec(await readFile(new URL('../supabase/migrations/'+file,import.meta.url),'utf8'));
}
await db.exec(`alter table sd_standard_cost add column hidden boolean default false;
 insert into sd_standard_cost(product_code) values('NEW');
 insert into sd_standard_cost(product_code,status,neg_stage,job_cost,fob_cost,efob_cost,frozen) values('OLD','approved','signed_off',10,20,30,true);
 grant all on all tables in schema public to service_role;
 grant usage,select on all sequences in schema public to service_role;`);
await db.exec(await readFile(new URL('../supabase/migrations/20261025113727_standard_cost_workflows.sql',import.meta.url),'utf8'));
await db.exec(await readFile(new URL('../supabase/migrations/20261025113914_standard_cost_audit_search_path.sql',import.meta.url),'utf8'));
await db.exec('alter table sd_standard_cost add column target_job numeric, add column target_fob numeric, add column target_efob numeric');
await db.exec(await readFile(new URL('../supabase/migrations/20261025190717_standard_cost_proposal_targets.sql',import.meta.url),'utf8'));
let checks = 0;
const q = async(sql,params=[]) => (await db.query(sql,params)).rows;
const ok = value => {assert.ok(value);checks++;};
const deny = async(sql,params=[]) => {await assert.rejects(()=>db.query(sql,params));checks++;};
const snapshot = async code => (await q('select sd_cost_snapshot($1) as s',[code]))[0].s;
const get = async id => (await q('select * from sd_cost_revision where id=$1',[id]))[0];
const call = async ({code='NEW',op='save',id=null,version=0,payload,reason='Test revision',sections=[],actor='owner@saadaa.in',admin=false}) =>
 (await q('select sd_cost_workflow($1,$2,$3,$4,$5::jsonb,$6,null,$7::text[],$8,$9) as id',[code,op,id,version,JSON.stringify(payload),reason,sections,actor,admin]))[0].id;
await db.exec('set role service_role');
const data = await snapshot('NEW');
data.rates={job_cost:10,fob_cost:20,efob_cost:30,total_po_avg_cost:25,proposed_cost:24};
data.fabric={fabric_code:'FAB',fabric_uom:'mtr',lines:[{colour:'Blue',size:'M',consumption:1,fabric_cost:10,cm_cost:5,total_cost:15}],extras:[]};
data.cmtp=[{category:'Labour',label:'Sewing',amount:5,position:0}];
data.documents={rfp_link:'https://example.com/rfp',cad_link:'',files:[{file_path:'NEW/00000000-0000-0000-0000-000000000001.pdf',file_name:'cad.pdf',file_size:100,doc_group:'single_piece',width:null,link_url:null,remark:null}]};
const id=await call({payload:data});
ok((await get(id)).kind==='new');
ok((await snapshot('NEW')).rates.job_cost===null); // Draft never changes live data.
const unauthorized=structuredClone(data);unauthorized.rates.target_job=9;
await assert.rejects(()=>call({id,version:2,payload:unauthorized}),/Only admin/);checks++;
const invalidExpected=structuredClone(data);invalidExpected.rates.proposed_cost=-1;
await assert.rejects(()=>call({id,version:2,payload:invalidExpected}),/nonnegative/);checks++;
await deny('select sd_cost_workflow($1,\'save\',$2,2,$3::jsonb,\'reason\',null,\'{}\',\'other@saadaa.in\',false)',['NEW',id,JSON.stringify(data)]);
await call({id,version:(await get(id)).version,op:'submit',payload:data});
await deny('select sd_cost_workflow($1,\'approve\',$2,3,$3::jsonb,\'\',null,\'{}\',\'owner@saadaa.in\',false)',['NEW',id,JSON.stringify(data)]);
await call({id,version:(await get(id)).version,op:'approve',payload:data,admin:true,actor:'admin@saadaa.in',sections:['rates']});
ok((await get(id)).status==='approved');
ok((await get(id)).approved_sections.length===4); // New cost cannot be partially approved.
ok((await snapshot('NEW')).cmtp[0].amount===5);
ok((await snapshot('NEW')).rates.proposed_cost===24);
ok((await q("select count(*)::int n from sd_standard_cost_rate_history where product_code='NEW'"))[0].n===1);
await assert.rejects(async()=>call({id,version:(await get(id)).version,payload:data}));checks++;
await deny("update sd_standard_cost set job_cost=99 where product_code='NEW'");
await deny("delete from sd_cmtp_component where product_code='NEW'");
await deny("delete from sd_cost_document where product_code='NEW'");
await deny('delete from sd_cost_revision_event');
await deny("insert into sd_standard_cost_rate_history(product_code,job_cost) values('NEW',999)");
// Frozen approved costs can be amended; unapproved sections never replace live data.
const old=await snapshot('OLD');
const patch=structuredClone(old);patch.rates.job_cost=12;patch.cmtp=[{category:'Labour',label:'Sewing',amount:7,position:0}];
const aid=await call({code:'OLD',op:'submit',payload:patch});
ok((await get(aid)).kind==='amendment');
ok((await snapshot('OLD')).rates.job_cost===10);
await call({code:'OLD',id:aid,version:(await get(aid)).version,op:'approve',payload:patch,admin:true,sections:['cmtp']});
ok((await get(aid)).status==='pending');
ok((await snapshot('OLD')).cmtp[0].amount===7);
ok((await snapshot('OLD')).rates.job_cost===10);
ok((await snapshot('OLD')).documents.files.length===0); // No CAD re-upload required.
let revision=await get(aid);
await assert.rejects(()=>call({code:'OLD',id:aid,version:revision.version-1,payload:patch}));checks++;
const forbidden=structuredClone(patch);forbidden.cmtp[0].amount=9;
await assert.rejects(()=>call({code:'OLD',id:aid,version:revision.version,payload:forbidden}));checks++;
await call({code:'OLD',id:aid,version:revision.version,op:'reject',payload:patch,admin:true,reason:'Fix the rates'});
revision=await get(aid);patch.rates.job_cost=13;
await call({code:'OLD',id:aid,version:revision.version,payload:patch});
ok((await get(aid)).status==='pending'); // Rejected edit resubmits automatically.
await call({code:'OLD',id:aid,version:(await get(aid)).version,op:'rework',payload:patch,admin:true,reason:'Review again'});
await call({code:'OLD',id:aid,version:(await get(aid)).version,payload:patch});
ok((await get(aid)).status==='pending');
await call({code:'OLD',id:aid,version:(await get(aid)).version,op:'approve',payload:patch,admin:true,sections:['rates']});
ok((await get(aid)).status==='approved');
ok((await snapshot('OLD')).rates.job_cost===13);
ok((await q("select frozen from sd_standard_cost where product_code='OLD'"))[0].frozen);
const events=await q('select * from sd_cost_revision_event where revision_id=$1 order by id',[aid]);
ok(events.some(e=>e.before_data.payload.rates.job_cost===12 && e.after_data.payload.rates.job_cost===13));
ok(events.every(e=>e.actor && e.before_data && e.after_data));
// Restoring the remaining pending section closes an amendment whose other section was approved.
let baseline=await snapshot('OLD'), next=structuredClone(baseline);
next.rates.job_cost=14;next.cmtp[0].amount=8;
const revertId=await call({code:'OLD',op:'submit',payload:next});
await call({code:'OLD',id:revertId,version:(await get(revertId)).version,op:'approve',payload:next,admin:true,sections:['cmtp']});
next.rates=baseline.rates;
await call({code:'OLD',id:revertId,version:(await get(revertId)).version,payload:next});
ok((await get(revertId)).status==='approved');
// Stale initial screens cannot silently overwrite a newer approved baseline.
await assert.rejects(()=>q("select sd_cost_workflow('OLD','submit',null,0,$1::jsonb,'stale',null,'{}','owner@saadaa.in',false,$2::jsonb)",[JSON.stringify(next),JSON.stringify(baseline)]));checks++;
// Any failure while applying a full submission rolls back every section and rate-history row.
await q("insert into sd_standard_cost(product_code) values('BROKEN')");
const broken=structuredClone(data);broken.fabric.lines.push({...broken.fabric.lines[0]});broken.documents.files[0].file_path='BROKEN/00000000-0000-0000-0000-000000000001.pdf';
const badId=await call({code:'BROKEN',op:'submit',payload:broken});
await assert.rejects(()=>call({code:'BROKEN',id:badId,version:2,op:'approve',payload:broken,admin:true}));checks++;
ok((await snapshot('BROKEN')).rates.job_cost===null);
ok((await q("select count(*)::int n from sd_standard_cost_rate_history where product_code='BROKEN'"))[0].n===0);
ok((await get(badId)).status==='pending');
await assert.rejects(()=>call({code:'BROKEN',payload:broken}));checks++;
// Pending drafts remain fully amendable, including removing the last line.
const empty=structuredClone(broken);empty.fabric.lines=[];
await call({code:'BROKEN',id:badId,version:(await get(badId)).version,payload:empty});
ok((await get(badId)).payload.fabric.lines.length===0);
// Admin targets stay staged, are audited, and become live only with rate approval.
const targetPayload=await snapshot('OLD');targetPayload.rates.target_job=11;targetPayload.rates.target_fob=21;
const targetId=await call({code:'OLD',op:'submit',payload:targetPayload,admin:true,actor:'admin@saadaa.in'});
ok((await snapshot('OLD')).rates.target_job===null);
await call({code:'OLD',id:targetId,version:(await get(targetId)).version,op:'approve',payload:targetPayload,admin:true,sections:['rates'],actor:'admin@saadaa.in'});
ok((await snapshot('OLD')).rates.target_job===11);
ok((await snapshot('OLD')).rates.target_fob===21);
ok((await q('select after_data from sd_cost_revision_event where revision_id=$1 order by id desc limit 1',[targetId]))[0].after_data.payload.rates.target_job===11);
// Authenticated clients cannot forge an actor, approve, or directly read the admin audit table.
await db.exec('reset role; set role authenticated');
await deny('select * from sd_cost_revision_event');
await deny("select sd_cost_workflow('NEW','save',null,0,'{}','',null,'{}','admin@saadaa.in',true)");
await deny("update sd_standard_cost set job_cost=123 where product_code='NEW'");
await db.exec("select set_config('sd.cost_workflow','approve',false)");
await deny("update sd_standard_cost set job_cost=123 where product_code='NEW'");
await db.exec('reset role; set role anon');
await deny('select * from sd_cost_revision');
await deny("select sd_cost_snapshot('NEW')");
console.log(`Standard Cost database workflow: ${checks} assertions passed.`);
await db.close();
