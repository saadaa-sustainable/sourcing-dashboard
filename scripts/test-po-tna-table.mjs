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
import React,{useState} from 'react';import {createRoot} from 'react-dom/client';import {PoTnaTable} from './src/app/po-approval/po-tna-table';
const stages=[['pp','PP sample',7],['gpt','GPT',14],['cut','Cutting start',21],['qc','Inline QC',30],['first','First delivery',45],['close','PO closing',50]];
function Fixture(){const [values,setValues]=useState(Object.fromEntries(stages.map(([k,l,d])=>[k,String(d)])));const [locked,setLocked]=useState(false);return <div className="wf-page"><div className="poa-drawer"><fieldset disabled={locked}><PoTnaTable rows={stages.map(([key,label,days])=>({key,label,days:values[key],standardDays:days}))} baseDate="2026-10-30" onDaysChange={(key,value)=>setValues(v=>({...v,[key]:value}))}/></fieldset><button onClick={()=>setLocked(true)}>Lock</button></div></div>;}
let checks=0;const check=(v,m)=>{if(!v)throw Error(m);checks++;};const sleep=ms=>new Promise(r=>setTimeout(r,ms));
const setValue=(el,value)=>{Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(el,value);el.dispatchEvent(new Event('input',{bubbles:true}));};
createRoot(document.getElementById('root')).render(<Fixture/>);
async function run(){
 await sleep(200);const table=document.querySelector('table');
 check(table.tHead.textContent==='TNA Critical PathStandard DaysDate','Three requested columns');
 check(table.tBodies[0].rows.length===6,'Six stages');
 const days=[...table.querySelectorAll('input[type="number"]')];const dates=[...table.querySelectorAll('input[type="date"]')];
 check(days.every(i=>i.required&&i.min==='0'&&i.step==='1'),'Required nonnegative whole days');
 check(dates.length===6&&dates.every(i=>i.required&&i.min==='2026-10-30'),'Six required editable dates with base minimum');
 check(dates[0].value==='2026-11-06','Projected date');
 setValue(days[0],'0');await sleep(50);check(dates[0].value==='2026-10-30','Zero offset valid');
 setValue(days[0],'25');await sleep(50);check(dates[0].value==='2026-11-24','Days update date');
 setValue(dates[0],'2026-12-01');await sleep(50);check(days[0].value==='32','Date updates day offset across month');
 check(dates[0].value==='2026-12-01','Edited date retained');
 setValue(dates[0],'2026-10-30');await sleep(50);check(days[0].value==='0','Base date yields zero days');
 setValue(dates[0],'2026-10-29');await sleep(50);check(days[0].value==='0'&&dates[0].value==='2026-10-30','Pre-base date cannot make negative offset');
 setValue(dates[0],'');await sleep(50);check(days[0].value===''&&dates[0].value==='','Clearing date clears required offset');
 setValue(days[0],'1.5');await sleep(50);check(dates[0].value==='','Fractional days do not project');
 check(table.querySelector('small').textContent==='Default: 7 days','Standard reference retained');
 check([...days,...dates].every(i=>Math.abs(i.getBoundingClientRect().height-36)<1),'Compact consistent inputs');
 check(document.querySelector('.poa-tna-table-wrap').clientWidth<=document.querySelector('.poa-drawer').clientWidth,'Table contained');
 document.querySelector('button').click();await sleep(50);check([...days,...dates].every(i=>i.matches(':disabled')),'Section lock retained');
 document.getElementById('result').textContent=JSON.stringify({ok:true,checks});
}
run().catch(e=>document.getElementById('result').textContent=JSON.stringify({ok:false,error:e.message,checks}));`;
const bundled=await build({stdin:{contents:entry,resolveDir:resolve('.'),loader:'tsx'},bundle:true,write:false,format:'iife',platform:'browser',jsx:'automatic',define:{'process.env.NODE_ENV':'"production"'}});
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
  const child=spawn(browser,['--headless', ...(process.env.PO_TNA_MOBILE==='true'?['--window-size=520,844']:['--window-size=1440,1000']), '--disable-gpu','--no-first-run','--no-default-browser-check',
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
console.log('PASS: '+report.checks+' real TNA table browser checks.');
