import assert from 'node:assert/strict';
import { build } from 'esbuild';
import { mkdtemp, writeFile, readFile, access } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createServer } from 'node:http';
import { spawn } from 'node:child_process';

// Actual React editor in isolated headless Chromium; auth/search/save are mocked.
const browsers=[process.env.CHROME_PATH,'C:/Program Files/Google/Chrome/Application/chrome.exe',
 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe','/usr/bin/chromium','/usr/bin/google-chrome'].filter(Boolean);
let browser;
for(const candidate of browsers) {try{await access(candidate);browser=candidate;break;}catch{}}
assert.ok(browser,'Set CHROME_PATH to an installed Chromium browser.');
const entry=`
import React from 'react';
import {createRoot} from 'react-dom/client';
import {MonthBoard} from './src/components/month-board';
import {buildPlanBoard} from './src/lib/inward-plan-v2/plan-board';
const statuses=['draft','pending_l2','approved','rejected'];
const plans=statuses.map((status,i)=>({id:'plan-'+i,title:['Winter receipts','October receipts','Summer receipts','Returned receipts'][i],status,
 period_kind:'monthly',period_start:i===0?'2026-11-01':'2026-10-01',period_end:i===0?'2026-11-30':'2026-10-31',
 submission_deadline:'2026-11-02T18:30:00Z',created_by:'owner@saadaa.in',revision:1}));
const data=buildPlanBoard(plans,[{plan_id:'plan-1',product_code:'SD',inward_qty:10,cost_per_piece:25}]);
window.errors=[];window.addEventListener('error',e=>window.errors.push(e.message));
createRoot(document.getElementById('root')).render(<div className="planBoard"><MonthBoard data={data} searchPlaceholder="Search plan or period..." pageBar={<a href="/inward-plan-v2?new=1">Create a Plan</a>}/></div>);
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
const check=(value,label)=>{if(!value)throw Error(label);window.checks=(window.checks||0)+1;};
const setValue=(el,value)=>{Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(el,value);el.dispatchEvent(new Event('input',{bubbles:true}));};
async function run(){
 await sleep(200);
 check(document.querySelectorAll('.mb-col').length===4,'Expected actual status columns');
 check(document.querySelectorAll('.mb-card').length===4,'Missing plans');
 check(getComputedStyle(document.querySelector('.mb-col.mb-t-draft')).backgroundColor==='rgb(234, 243, 255)','Draft column color mismatch');
 check(getComputedStyle(document.querySelector('.mb-col.mb-t-pending')).backgroundColor==='rgb(255, 245, 218)','Pending column color mismatch');
 check(getComputedStyle(document.querySelector('.mb-col.mb-t-live')).backgroundColor==='rgb(228, 244, 238)','Approved column color mismatch');
 check(document.querySelector('.mb-col[aria-label="Approval Pending"]').textContent.includes('10 pieces / 1 products'),'Pending card quantities missing');
 check(document.querySelector('a[href="/inward-plan-v2?new=1"]').textContent==='Create a Plan','Create link missing');
 check(document.querySelector('.mb-card a').href.includes('/inward-plan-v2?id='),'Open plan destination missing');
 const actions=document.querySelector('.mb-card .mb-actions');
 check([...actions.querySelectorAll('a')].map(a=>a.textContent).join('|')==='Open plan|Analytics|GRN Delay Tracker','Expected all three actions beside each other');
 check(actions.querySelectorAll('a')[1].href.includes('cadence=monthly&start=2026-11-01'),'Analytics must open the plan period');
 const filter=[...document.querySelectorAll('.segment button')].find(b=>b.textContent.includes('Approval Pending'));
 filter.click();await sleep(30);
 check(document.querySelectorAll('.mb-card').length===1,'Status filter failed');
 document.querySelector('.segment button').click();await sleep(30);
 const search=document.querySelector('input[type=search]');setValue(search,'November');await sleep(30);
 check(document.querySelectorAll('.mb-card').length===1&&document.querySelector('.mb-card').textContent.includes('Winter receipts'),'Month search failed');
 setValue(search,'');await sleep(30);
 const view=document.querySelector('select[aria-label="Choose board view"]');
 view.value='list';view.dispatchEvent(new Event('change',{bubbles:true}));await sleep(30);
 check(document.querySelectorAll('tbody tr').length===4,'List switch failed');
 check(document.querySelectorAll('tbody tr .mb-list-actions a').length===12,'List view must retain all three actions per plan');
 view.value='cards';view.dispatchEvent(new Event('change',{bubbles:true}));await sleep(30);
 check(document.querySelectorAll('.mb-grid .mb-card').length===4,'Cards switch failed');
 check(window.errors.length===0,'Browser runtime error');
 document.getElementById('result').textContent=JSON.stringify({ok:true,checks:window.checks});
}
run().catch(error=>document.getElementById('result').textContent=JSON.stringify({ok:false,error:error.message,checks:window.checks}));
`;
const bundled=await build({stdin:{contents:entry,resolveDir:resolve('.'),loader:'tsx'},bundle:true,write:false,format:'iife',platform:'browser',jsx:'automatic',define:{'process.env.NODE_ENV':'"production"'},plugins:[{name:'mock-next',setup(plugin){
 plugin.onResolve({filter:/^next\/(link|navigation)$/},args=>({path:args.path,namespace:'mock-next'}));
 plugin.onLoad({filter:/.*/,namespace:'mock-next'},args=>({contents:args.path==='next/link'?'import React from "react";export default function Link({children,...props}){return React.createElement("a",props,children);}':'export const useRouter=()=>({push:href=>{window.destination=href;}});',loader:'js',resolveDir:resolve('.')}));
}}]});
const directory=await mkdtemp(join(tmpdir(),'inward-v2-editor-'));
await writeFile(join(directory,'bundle.js'),bundled.outputFiles[0].text);
const boardCss=(await readFile(resolve('src/app/inward-plan-v2/v2.module.css'),'utf8')).replace(/:global\(([^)]+)\)/g,'$1');
const globalCss=(await Promise.all(['globals.css','workflows.css','toolbar.css'].map(file=>readFile(resolve('src/app',file),'utf8')))).join('\n').replace(/^@import.*;$/gm,'')+'\n'+boardCss;
await writeFile(join(directory,'index.html'),'<!doctype html><html><head><style>'+globalCss+'</style></head><body><div id="root" class="app-shell"></div><pre id="result">RUNNING</pre><script src="./bundle.js"></script></body></html>');
const host=process.env.V2_TEST_HOST || '127.0.0.1';
const server=createServer(async(request,response)=>{
 try {
  const name=request.url==='/bundle.js'?'bundle.js':'index.html';
  response.setHeader('Content-Type',name.endsWith('.js')?'text/javascript':'text/html');
  response.end(await readFile(join(directory,name)));
 } catch(error) {response.statusCode=500;response.end(String(error));}
});
await new Promise((resolve,reject)=>{server.once('error',reject);server.listen(0,host,resolve);});
let result;
try {
 result=await new Promise((resolve,reject)=>{
  const child=spawn(browser,['--headless','--disable-gpu','--no-first-run','--no-default-browser-check',
   '--user-data-dir='+join(directory,'profile'),'--virtual-time-budget=5000','--dump-dom',
   'http://'+host+':'+server.address().port],{windowsHide:true,stdio:['ignore','pipe','pipe']});
  let stdout='',stderr='';
  const timeout=setTimeout(()=>{child.kill();reject(Error('Browser timeout'));},30000);
  child.stdout.on('data',chunk=>stdout+=chunk);
  child.stderr.on('data',chunk=>stderr+=chunk);
  child.once('error',reject);
  child.once('close',code=>{clearTimeout(timeout);resolve({stdout,stderr,code});});
 });
} finally {await new Promise(resolve=>server.close(resolve));}
const match=result.stdout.match(/<pre id="result">([^<]*)<\/pre>/);
assert.ok(match,'Browser did not produce results: '+result.stderr.slice(-1000));
const report=JSON.parse(match[1].replaceAll('&quot;','"').replaceAll('&amp;','&'));
assert.equal(report.ok,true,JSON.stringify(report));
console.log('PASS: '+report.checks+' All plans browser assertions.');
