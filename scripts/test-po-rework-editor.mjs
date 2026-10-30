import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import vm from 'node:vm';
import ts from 'typescript';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
const require = createRequire(import.meta.url);
const compile = (file, resolver) => {
 const exports = {};
 const source = ts.transpileModule(readFileSync(file,'utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,jsx:ts.JsxEmit.ReactJSX,target:ts.ScriptTarget.ES2022}}).outputText;
 vm.runInNewContext(source,{exports,require:resolver,console,Date,setTimeout,clearTimeout});
 return exports;
};
const sections = compile('src/lib/po-rework.ts',require);
const board = compile('src/lib/po-board.ts',require);
const child = ({children}) => React.createElement('div',null,children);
const componentMocks = new Proxy({}, {get:(_,key)=>key==='PoLinesPanel'
 ? ({editable})=>React.createElement('div',{'data-sku-editable':String(editable)})
 : child});
const approval = {
 canEdit:()=>true, canApprove:()=>false, canDeletePo:()=>false, canSubmit:()=>true,
 isPlanFrozen:()=>false, routeApproval:()=> 'team', monthStart:()=> '2026-10-01',
 addMonths:()=> '2026-11-01', monthLabel:()=> 'October 2026', STATUS_LABEL:{rework:'Rework'}
};
const {PoApprovalClient} = compile('src/app/po-approval/po-approval-client.tsx',name=>{
 if(name==='react'||name==='react/jsx-runtime')return require(name);
 if(name==='@/lib/po-rework')return sections;
 if(name==='@/lib/po-board')return board;
 if(name==='@/lib/forms/approval')return approval;
 if(name==='@/lib/business-logic')return {tnaBaseFor:()=>({source:'today',date:'2026-10-23'}),awaitingEasycomDays:()=>null,addTnaDays:()=>null};
 return componentMocks;
});
let checks=0;
for(let mask=1;mask<8;mask++){
 const selected=['cost','tna','sku'].filter((_,i)=>mask&(1<<i));
 const po={id:1,request_id:'PR-TEST',status:'rework',rework_sections:selected,rework_notes:'Fix selected sections',category:'fg',po_type:'FOB',product_code:'SD',vendor_code:'V1',po_qty:10,rate:20,created_at:'2026-10-23',timestamp_created:'2026-10-23'};
 const html=renderToStaticMarkup(React.createElement(PoApprovalClient,{
 pos:[po],cycle:{},linesByPo:{1:[{id:1,qty:10}]},capacity:{},productCodes:[],vendorCodes:[],
 vendorNames:{},vendorTypes:{},productNames:{},deboarded:{},submissions:[],
 leadtimes:{},stdCm:{},role:'team',userEmail:'owner@example.com',initialEditId:1
 }));
 const groups=[...html.matchAll(/<fieldset([^>]*)class="poa-section-fields"[^>]*>/g)];
 assert.equal(groups.length,4);checks++;
 for(const [i,key] of ['order','cost','tna','plan'].entries()){
  assert.equal(groups[i][1].includes('disabled'),!selected.includes(key));checks++;
 }
 const panels=[...html.matchAll(/<section class="poa-steppanel" role="tabpanel"([^>]*)>/g)];
 const active=selected.includes('cost')?1:selected.includes('tna')?2:4;
 assert.equal(panels[active][1].includes('hidden'),false);checks++;
 assert.ok(html.includes('Only these sections can be edited'));checks++;
 if(active===4){assert.ok(html.includes('data-sku-editable="true"'));checks++;}
}
console.log(checks+' real editor render assertions passed (mocked child components/data).');
