import assert from 'node:assert/strict';
import vm from 'node:vm';
import ts from 'typescript';
import {readFileSync} from 'node:fs';
const compile=(file,require)=>{
 const exports={};
 vm.runInNewContext(ts.transpileModule(readFileSync(file,'utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}}).outputText,{exports,require,FormData,console,Date});
 return exports;
};
const helper=compile('src/lib/po-rework.ts',()=>({}));
let row,error=null,writes=0;
const db={from(table){
 let columns,operation='read';
 const q={
  select(value){columns=value;return q;},eq(){return q;},neq(){return q;},
  update(){operation='write';writes++;return q;},delete(){operation='write';writes++;return q;},insert(){operation='write';writes++;return q;},
  maybeSingle:async()=>{assert.equal(columns,'*');return {data:row,error};},
  then(resolve,reject){return Promise.resolve({data:operation==='read'?[]:null,error:null}).then(resolve,reject);}
 };return q;
}};
const shared={supa:async()=>db,fail:error=>({ok:false,error}),done:message=>({ok:true,message}),writeLog:async()=>{}};
const actions=compile('src/lib/forms/actions-modules/po-lines-cutting.ts',name=>{
 if(name==='@/lib/po-rework')return helper;
 if(name==='./_shared')return shared;
 if(name==='../queries')return {currentUser:async()=>({role:'team',email:'test@example.com'})};
 if(name==='../approval')return {canEdit:()=>true,statusOnSubmit:()=> 'submitted'};
 if(name==='next/cache')return {revalidatePath:()=>{}};
 return {};
});
const form=new FormData();form.set('po_id','42');form.set('lines',JSON.stringify([{product_variant:'SD',size:'S',qty:20}]));
row={status:'draft',po_qty:10,category:'fg',request_id:'PR-42'};
assert.equal((await actions.savePoLines(form)).ok,true);assert.ok(writes>0);
error={message:'database unavailable'};writes=0;
assert.equal((await actions.savePoLines(form)).error,'Could not load PO: database unavailable');assert.equal(writes,0);
error=null;row=null;
assert.equal((await actions.savePoLines(form)).error,'PO not found.');assert.equal(writes,0);
row={status:'rework',rework_sections:['cost']};
assert.match((await actions.savePoLines(form)).error,/not selected for rework/);assert.equal(writes,0);
row={status:'approved'};
assert.match((await actions.savePoLines(form)).error,/approved PO/);assert.equal(writes,0);
row={status:'rework',rework_sections:['sku'],po_qty:10,request_id:'PR-42'};
assert.equal((await actions.savePoLines(form)).ok,true);
console.log('Legacy schema saves, migrated rework guards, query errors and missing/approved PO checks passed.');
