import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';
import ts from 'typescript';

class V2SignInRequired extends Error {}
let authError;
let sourceError;
let reads=0;
let argumentsSeen;
const sandbox=vm.createContext({Response,URL,Error});
const dependency=new vm.SyntheticModule(['context','findSources','V2SignInRequired'],function(){
 this.setExport('V2SignInRequired',V2SignInRequired);
 this.setExport('context',async()=>{if(authError)throw authError;return {};});
 this.setExport('findSources',async(...args)=>{reads++;argumentsSeen=args;if(sourceError)throw sourceError;return [{po_detail_id:'real-detail'}];});
},{context:sandbox});
const source=await readFile(new URL('../src/app/inward-plan-v2/sources/route.ts',import.meta.url),'utf8');
const output=ts.transpileModule(source,{compilerOptions:{module:ts.ModuleKind.ESNext,target:ts.ScriptTarget.ES2022}}).outputText;
const module=new vm.SourceTextModule(output,{context:sandbox});
await module.link(()=>dependency);await module.evaluate();
const get=url=>module.namespace.GET(new Request('http://localhost'+url));
let checks=0;
const ok=value=>{assert.ok(value);checks++;};
authError=new V2SignInRequired('Sign in required');
let response=await get('/inward-plan-v2/sources?query=PO');
ok(response.status===401&&reads===0);
ok(response.headers.get('cache-control')==='private, no-store');
authError=new Error('Page access denied');
response=await get('/inward-plan-v2/sources');
ok(response.status===403&&reads===0);
authError=null;
response=await get('/inward-plan-v2/sources?field=unsafe');
ok(response.status===400&&reads===0);
response=await get('/inward-plan-v2/sources?query=SDCP');
ok(response.status===200&&reads===1);
assert.deepEqual(argumentsSeen,['SDCP','product']);checks++;
ok((await response.json()).rows[0].po_detail_id==='real-detail');
response=await get('/inward-plan-v2/sources?query=SDCPBL&field=variant');
assert.deepEqual(argumentsSeen,['SDCPBL','variant']);checks++;
ok(response.status===200&&response.headers.get('cache-control')==='private, no-store');
for (const field of ['po','sku']) {
 response=await get('/inward-plan-v2/sources?field='+field);ok(response.status===400);
}
sourceError=new Error('Source unavailable');
response=await get('/inward-plan-v2/sources');
ok(response.status===400&&(await response.json()).error==='Source unavailable');
console.log('PASS: '+checks+' source endpoint authentication, page-access, search and error assertions.');
