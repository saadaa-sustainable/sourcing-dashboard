import assert from 'node:assert/strict';
import vm from 'node:vm';
import ts from 'typescript';
import {readFileSync} from 'node:fs';
const compile=(file,require)=>{const exports={};vm.runInNewContext(ts.transpileModule(readFileSync(file,'utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}}).outputText,{exports,require,console});return exports;};
const board=compile('src/lib/po-board.ts',()=>({}));
const shared=compile('src/lib/forms/queries-modules/_shared.ts',()=>({}));
let failed=false;const requests=[];
const db={from(table){assert.equal(table,'sd_ee_grn');let column,values;
 const q={select(value){assert.equal(value,'po_number, po_ref_num, received_quantity');return q;},
 in(c,v){column=c;values=v;assert.ok(v.length<=100);return q;},
 gt(c,v){assert.equal(c,'received_quantity');assert.equal(v,0);return q;},
 order(c){assert.equal(c,'grn_detail_id');return q;},
 range:async(from,to)=>{requests.push({column,from,to});if(failed)return {data:null,error:{message:'GRN unavailable'}};
 const rows=column==='po_ref_num'&&values.includes('REF-1')?Array.from({length:1501},(_,i)=>({po_number:'EE-X',po_ref_num:'REF-1',received_quantity:1})):[];
 return {data:rows.slice(from,to+1),error:null};}};return q;}};
const query=compile('src/lib/forms/queries-modules/po-approval.ts',name=>name==='./_shared'?{client:async()=>db,pageAll:shared.pageAll,PAGE_SIZE:1000}:name==='@/lib/po-board'?board:{});
const result=await query.loadPoGrnMatches([{id:1,status:'approved',easycom_po_no:'EE-1',po_ref_num:'REF-1'},{id:2,status:'approved',easycom_po_no:'EE-2',po_ref_num:'REF-2'},{id:3,status:'draft',easycom_po_no:'EE-3',po_ref_num:'REF-3'}]);
assert.equal(result['1'],true);assert.equal(result['2'],false);assert.equal(result['3'],undefined);
assert.ok(requests.some(r=>r.column==='po_ref_num'&&r.from===1000));
failed=true;await assert.rejects(()=>query.loadPoGrnMatches([{id:1,status:'approved',easycom_po_no:'EE-1'}]),/GRN unavailable/);
console.log('GRN loader verified: 1501 receipts paged, number/reference paths, draft exclusion, errors propagated.');
