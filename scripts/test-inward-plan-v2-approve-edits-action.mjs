import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import vm from 'node:vm';
import ts from 'typescript';
let role='team',calls=[],rpcError=null;
const id='00000000-0000-4000-8000-000000000001';
const sandbox=vm.createContext({FormData,Error,Date,console});
const synthetic=(exports)=>new vm.SyntheticModule(Object.keys(exports),function(){for(const [key,value] of Object.entries(exports))this.setExport(key,value);},{context:sandbox});
const deps={
 '@/lib/inward-plan-v2/server':synthetic({validationErrors:async()=>[],context:async()=>({role,db:{rpc:async(name,payload)=>{calls.push({name,payload});return {data:id,error:rpcError};}}})}),
 'next/cache':synthetic({revalidatePath:()=>{}}),
 'next/navigation':synthetic({redirect:href=>{throw Error('REDIRECT:'+href);}}),
};
const compile=async file=>new vm.SourceTextModule(ts.transpileModule(await readFile(new URL(file,import.meta.url),'utf8'),{compilerOptions:{module:ts.ModuleKind.ESNext,target:ts.ScriptTarget.ES2022}}).outputText,{context:sandbox});
deps['@/lib/inward-plan-v2/validation']=await compile('../src/lib/inward-plan-v2/validation.ts');
const module=await compile('../src/app/inward-plan-v2/actions.ts');
await module.link(spec=>{if(!deps[spec])throw Error(spec);return deps[spec];});await module.evaluate();
function form(intent='approve_with_edits') {
 const data=new FormData();
 for(const [key,value] of Object.entries({plan_id:id,title:'Edited',period_kind:'monthly',period_start:'2099-01-01',remarks:'',version:'2098-12-01T00:00:00Z',intent,approval_notes:'Reviewed',lines:JSON.stringify([{planning_level:'product',po_number:'PO-1',product_code:'SD',expected_date:'2099-01-04',inward_qty:'240',cost_per_piece:'25',remarks:''}])})) data.set(key,value);
 return data;
}
let checks=0;const ok=value=>{assert.ok(value);checks++;};
let result=await module.namespace.savePlan({},form());ok(!result.ok&&calls.length===0);
role='viewer';result=await module.namespace.savePlan({},form(''));ok(!result.ok&&calls.length===0);
role='admin';
await assert.rejects(()=>module.namespace.savePlan({},form()),/REDIRECT:.*approved=1/);checks++;
ok(calls.length===1&&calls[0].name==='sd_inward_v2_approve_with_edits');
ok(calls[0].payload.p_header.id===id&&calls[0].payload.p_lines[0].inward_qty==='240'&&calls[0].payload.p_notes==='Reviewed');
rpcError={message:'Plan changed. Reload before approving'};
result=await module.namespace.savePlan({},form());ok(!result.ok&&result.message.includes('Plan changed'));
rpcError=null;
const oversized=form();oversized.set('approval_notes','x'.repeat(4001));const before=calls.length;
result=await module.namespace.savePlan({},oversized);ok(!result.ok&&calls.length===before);
for(const decision of ['rework','reject']) {
 const data=form();data.set('decision',decision);
 result=await module.namespace.reviewPlan({},data);ok(!result.ok&&calls.length===before);
}
const approve=form();approve.set('decision','approve');approve.set('notes','Approved');
result=await module.namespace.reviewPlan({},approve);ok(result.ok&&calls.at(-1).name==='sd_inward_v2_decide'&&calls.at(-1).payload.p_id===id&&calls.at(-1).payload.p_action==='approve');
await assert.rejects(()=>module.namespace.savePlan({},form('')),/REDIRECT:.*saved=1/);checks++;
ok(calls.at(-1).name==='sd_inward_v2_save');
console.log('PASS: '+checks+' approve-with-edits server action assertions.');
