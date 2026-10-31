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
import React from 'react';import {createRoot} from 'react-dom/client';import {BuyingPlanRuleEditor} from './src/app/rules-master/buying-plan-rule-editor';
const users=[{email:'a@saadaa.in',full_name:'Approver A',role:'team',is_active:true},{email:'b@saadaa.in',full_name:'Approver B',role:'team',is_active:true},{email:'inactive@saadaa.in',role:'team',is_active:false},{email:'viewer@saadaa.in',role:'viewer',is_active:true}];
let checks=0;const check=(v,m)=>{if(!v)throw Error(m);checks++;};const sleep=ms=>new Promise(r=>setTimeout(r,ms));
const setValue=(el,value)=>{Object.getOwnPropertyDescriptor(el.tagName==='SELECT'?HTMLSelectElement.prototype:HTMLInputElement.prototype,'value').set.call(el,value);el.dispatchEvent(new Event(el.tagName==='SELECT'?'change':'input',{bubbles:true}));};
createRoot(document.getElementById('root')).render(<div className="wf-page wf-rules-master ui-view-rules-master"><BuyingPlanRuleEditor rule={null} users={users}/></div>);
async function run(){await sleep(200);const selects=document.querySelectorAll('select');check(selects.length===2,'Two user selectors');check(selects[0].options.length===3,'Only active eligible users');check(document.body.textContent.includes('Buying Plan approval'),'Settings section');check(document.body.textContent.includes('L2 can approve any plan value'),'L2 override explained');
setValue(selects[0],'a@saadaa.in');await sleep(50);check(selects[1].querySelector('option[value="a@saadaa.in"]').disabled,'Duplicate approver disabled');setValue(selects[1],'b@saadaa.in');setValue(document.querySelector('input'),'100000.50');await sleep(50);document.querySelector('form').requestSubmit();await sleep(50);check(window.saved.max_value==='100000.50','Threshold saved exactly');check(window.saved.l1_email==='a@saadaa.in','L1 mapping');check(window.saved.l2_email==='b@saadaa.in','L2 mapping');check(document.body.textContent.includes('Approval rule saved.'),'Success feedback');
const controls=[...document.querySelectorAll('.bp-approval-rule-field select,.bp-approval-rule-field input')];
check(controls.every(el=>Math.abs(el.getBoundingClientRect().height-40)<1),'Consistent 40px fields');
check(getComputedStyle(document.querySelector('.bp-approval-rule-field label')).fontSize==='12px','Theme label size');
check(getComputedStyle(document.querySelector('.bp-approval-rule-heading h3')).fontSize==='14px','Theme heading size');
check(getComputedStyle(document.querySelector('.bp-approval-rule-grid')).gridTemplateColumns.split(' ').length===(innerWidth<=900?1:3),'Responsive grid columns');
if(innerWidth>900)check(controls.every(el=>Math.abs(el.getBoundingClientRect().top-controls[0].getBoundingClientRect().top)<1),'Field tops aligned');
check(document.querySelector('.bp-approval-rule-badge').textContent==='Configured','Saved status updates');
check(document.querySelector('form').scrollWidth<=document.querySelector('form').clientWidth+1,'No form overflow');document.getElementById('result').textContent=JSON.stringify({ok:true,checks});}
run().catch(e=>document.getElementById('result').textContent=JSON.stringify({ok:false,error:e.message,checks}));`;
const bundled=await build({stdin:{contents:entry,resolveDir:resolve('.'),loader:'tsx'},bundle:true,write:false,format:'iife',platform:'browser',jsx:'automatic',define:{'process.env.NODE_ENV':'"production"'},plugins:[{name:'mock-actions',setup(p){p.onResolve({filter:/^\.\/buying-plan-rule-actions$/},()=>({path:'actions',namespace:'mock'}));p.onLoad({filter:/.*/,namespace:'mock'},()=>({contents:'export async function saveBuyingPlanApprovalRule(form){window.saved=Object.fromEntries(form);return {ok:true};}',loader:'js'}));p.onResolve({filter:/^next\/navigation$/},()=>({path:'navigation',namespace:'navigation'}));p.onLoad({filter:/.*/,namespace:'navigation'},()=>({contents:'export const useRouter=()=>({refresh(){}});',loader:'js'}));}}]});
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
  const child=spawn(browser,['--headless', ...(process.env.BP_RULE_MOBILE==='true'?['--window-size=520,844']:['--window-size=1440,1000']), '--disable-gpu','--no-first-run','--no-default-browser-check',
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
console.log('PASS: '+report.checks+' Rules Master browser checks, real editor and mocked action.');
