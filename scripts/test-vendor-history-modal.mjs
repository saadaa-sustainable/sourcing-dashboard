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

const fixture={vendorCode:'BAH',vendorName:'Balaji Arts',productCode:'SDALP',rows:[],averageDays:null,totalPos:0,onTimePct:null,lastAny:null,lastSameProduct:null,analytics:{all:{pos:4,datedPos:4,otif:75,onTime:75,fill:100,delay:2},same:{pos:2,datedPos:2,otif:50,onTime:50,fill:100,delay:4},capacity:{entered:true,capacityPerMonth:8320,capacityUtil:40,headcount:20,reportDate:'2026-10-30',inProcessQty:3328,leadDays:30,poCapacity:8320,available:4992,daysRemaining:18,poQty:100,recommendation:'Review before issuing',reasons:['Some dated POs were late.']}}};
if(process.env.VENDOR_HISTORY_ZERO==='true'){fixture.analytics.all={...fixture.analytics.all,pos:40,datedPos:37,otif:0,onTime:0};}
const entry=`
import React from 'react';import {createRoot} from 'react-dom/client';import {VendorHistoryButton} from './src/components/vendor-history-modal';
const sleep=ms=>new Promise(r=>setTimeout(r,ms));let checks=0;const check=(v,label)=>{if(!v)throw Error(label);checks++;};
createRoot(document.getElementById('root')).render(<VendorHistoryButton vendorCode="BAH" productCode="SDALP" poQty={100} poType="job_work" label="View Vendor Performance Analytics" className="wf-btn wf-btn-ghost wf-btn-sm poa-vendor-analytics-button"/>);
async function run(){await sleep(200);check(getComputedStyle(document.querySelector('button')).backgroundColor==='rgb(255, 245, 217)','Analytics entry button is yellow under the full theme');document.querySelector('button').click();await sleep(300);const dialog=document.querySelector('[role="dialog"]');check(dialog,'Modal opens');
for(const label of ['Vendor Capacity Analytics','Monthly capacity','Current utilisation','Last reported headcount','Report date','Active in-process quantity','Capacity days remaining','OTIF','On-time rate','Fill rate','Average delay','Same product - SDALP','Review before issuing'])check(dialog.textContent.includes(label),label);
if (${process.env.VENDOR_HISTORY_ZERO==='true'}) {
 const row=dialog.querySelector('.vh-performance tbody tr');
 check(row.cells[3].textContent==='0%','Zero OTIF must display 0%');
 check(row.cells[4].textContent==='0%','Zero on-time must display 0%');
 check(getComputedStyle(row.cells[3].querySelector('strong')).visibility==='visible','Zero OTIF visible');
 check(dialog.textContent.includes('37 received POs with delivery due dates'),'Dated denominator explained');
 check(dialog.textContent.includes('3 received POs without a due date'),'Missing dates excluded explicitly');
}
check(window.context.poQty===100 && window.context.poType==='job_work','Current PO context forwarded');
check(getComputedStyle(dialog.querySelector('.vh-analytics')).backgroundColor==='rgb(255, 249, 232)','Yellow theme');
check(dialog.querySelector('.vh-analytics').getBoundingClientRect().width<=dialog.querySelector('.vh-modal').getBoundingClientRect().width,'Analytics fits modal');
const grid=dialog.querySelector('.vh-capacity-grid');
check(getComputedStyle(grid).gridTemplateColumns.split(' ').length===(innerWidth<=650?2:3),'Responsive metric columns');
check(getComputedStyle(grid.querySelector('dt')).fontSize==='12px','Metric label theme size');
check(getComputedStyle(dialog.querySelector('.vh-performance tbody td')).textAlign==='right','Performance numbers right aligned');
check(getComputedStyle(dialog.querySelector('.vh-performance tbody th')).textAlign==='left','Performance scope left aligned');
check(getComputedStyle(dialog.querySelector('.vh-header-actions .wf-btn')).whiteSpace==='nowrap','Header action label stays on one line');
check(dialog.querySelector('.vh-modal').scrollWidth<=dialog.querySelector('.vh-modal').clientWidth+1,'Modal has no horizontal overflow');
check(dialog.querySelector('.vh-modal').getBoundingClientRect().height<=innerHeight-55,'Modal stays within viewport');
dialog.querySelector('summary').click();check(dialog.textContent.includes('Fill rate is the percentage'),'Definitions available');
dialog.querySelector('[aria-label="Close"]').click();await sleep(50);check(!document.querySelector('[role="dialog"]'),'Close works');
document.getElementById('result').textContent=JSON.stringify({ok:true,checks});}
run().catch(e=>document.getElementById('result').textContent=JSON.stringify({ok:false,error:e.message,checks}));`;
const bundled=await build({stdin:{contents:entry,resolveDir:resolve('.'),loader:'tsx'},bundle:true,write:false,format:'iife',platform:'browser',jsx:'automatic',define:{'process.env.NODE_ENV':'"production"'},plugins:[{name:'mock-action',setup(p){p.onResolve({filter:/^@\/lib\/forms\/actions$/},()=>({path:'actions',namespace:'mock'}));p.onLoad({filter:/.*/,namespace:'mock'},()=>({contents:'export async function getVendorPoHistory(v,p,c){window.context=c;return '+JSON.stringify(fixture)+';}',loader:'js'}));}}]});
const directory=await mkdtemp(join(tmpdir(),'inward-v2-editor-'));
await writeFile(join(directory,'bundle.js'),bundled.outputFiles[0].text);
const globalCss=(await Promise.all(['globals.css','workflows.css','po-approval.css','shopify-ui.css','search-bars.css','toolbar.css'].map(file=>readFile(resolve('src/app',file),'utf8')))).join('\n').replace(/^@import.*;$/gm,'');
await writeFile(join(directory,'index.html'),'<!doctype html><html><head><style>'+globalCss+'</style></head><body><div id="root" class="app-shell ui-shopify"></div><pre id="result">RUNNING</pre><script src="./bundle.js"></script></body></html>');
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
  const child=spawn(browser,['--headless', ...(process.env.VENDOR_HISTORY_MOBILE==='true'?['--window-size=520,844']:['--window-size=1440,1000']), '--disable-gpu','--no-first-run','--no-default-browser-check',
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
console.log('PASS: '+report.checks+' real vendor-history browser assertions, mocked action.');
