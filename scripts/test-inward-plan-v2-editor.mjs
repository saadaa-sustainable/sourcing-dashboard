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
const fixture={po_detail_id:'detail-1',po_number:'PO-1',po_ref_num:'REF-1',product_code:'SD',
 inventory:[{sku:'V_S',size:null,current_stock:24,doq_45:3}],product_variant:'V',sku:'SKU_S',size:'S',vendor_name:'Vendor',pending_qty:100,item_price:25,expected_delivery_date:'2026-10-28'};
const reviewMode=process.env.V2_TEST_REVIEW==='true';
const approvedMode=process.env.V2_TEST_APPROVED==='true';
const plan=process.env.V2_TEST_EXISTING==='true'?{"id":"00000000-0000-4000-8000-000000000001","title":"Saved October draft","remarks":"","status":"draft","period_kind":"monthly","period_start":"2026-10-01","period_end":"2026-10-31","submission_deadline":"2026-10-02T18:30:00Z","submitted_at":null,"created_by":"owner@saadaa.in","updated_by":"owner@saadaa.in","updated_at":"2026-10-22T10:00:00Z","created_at":"2026-10-22T10:00:00Z","approved_by":null,"approved_at":null,"decision_notes":null,"revision":1}:null;
if (reviewMode && plan) plan.status='pending_l2';
if (approvedMode && plan) {plan.status='approved';plan.approved_by='admin@saadaa.in';plan.approved_at='2026-10-22T12:00:00Z';}
const entry=`
import React from 'react';
import {createRoot} from 'react-dom/client';
import {Workspace} from './src/app/inward-plan-v2/workspace';
const source=${JSON.stringify(fixture)};
window.saveCalls=0; window.searchCalls=0; window.errors=[];
window.addEventListener('error',e=>window.errors.push(e.message));
window.fetch=async()=>{window.searchCalls++;return new Response(JSON.stringify({rows:[source]}),{status:200,headers:{'content-type':'application/json'}});};
createRoot(document.getElementById('root')).render(<div className="wf-page"><Workspace plan={${JSON.stringify(plan)}} lines={[]} sources={[source,{...source,po_detail_id:'detail-2',sku:'SKU_M',size:'M',pending_qty:50}]} role="${reviewMode||approvedMode?'admin':'team'}" email="owner@saadaa.in" today="2026-10-22"/></div>);
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
const check=(value,label)=>{if(!value)throw Error(label);window.checks=(window.checks||0)+1;};
const setValue=(element,value)=>{Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(element,value);element.dispatchEvent(new Event('input',{bubbles:true}));};
async function run(){
 await sleep(200);
 if (${approvedMode}) {
   const summary=document.querySelector('[aria-label="Plan summary"]');
   const card=summary.closest('section');
   const receipts=[...document.querySelectorAll('h2')].find(heading=>heading.textContent==='Planned receipts');
   const review=[...document.querySelectorAll('h3')].find(heading=>heading.textContent==='Review and decision');
   check(receipts.closest('section')===card,'Summary and receipts must share one card');
   check(card.contains(review),'Review must be inside the shared card');
   check(!review.closest('section').classList.contains('card'),'Review must not render a separate outer card');
   check(summary.textContent.includes('Approved by admin@saadaa.in'),'Approval metadata must remain visible');
   check(!document.querySelector('input[name="title"]'),'Approved plan must remain locked');
   check(!!document.querySelector('button[value="reopen"]'),'Admin reopen action must remain available');
   check(!document.querySelector('button[value="approve_with_edits"]'),'Approved plan must not allow direct approval edits');
   document.getElementById('result').textContent=JSON.stringify({ok:true,checks:window.checks,errors:window.errors});
   return;
 }
 if (${Boolean(plan)}) {
   const editorHeading=[...document.querySelectorAll('h2')].find(heading=>heading.textContent==='Edit plan');
   const editorCard=editorHeading.closest('section');
   const summary=document.querySelector('[aria-label="Plan summary"]');
   check(!!summary&&summary.closest('section')===editorCard,'Summary must share the Edit plan card');
   check(!!(summary.compareDocumentPosition(editorHeading)&Node.DOCUMENT_POSITION_FOLLOWING),'Summary must precede Edit plan');
   check(editorHeading.getBoundingClientRect().top>=summary.getBoundingClientRect().bottom,'Edit plan must appear below the summary');
   check(summary.textContent.includes('Saved October draft')&&summary.textContent.includes('${reviewMode?'Approval Pending':'Draft'}'),'Summary title/status changed');
   const paragraphs=[...summary.querySelectorAll('p')];
   check(getComputedStyle(paragraphs[0]).textTransform==='none','Summary must not inherit uppercase navigation styles');
   check(paragraphs[1].getBoundingClientRect().top>paragraphs[0].getBoundingClientRect().bottom,'Summary details must stack on separate lines');
   check(getComputedStyle(summary).position==='static','Summary must not inherit sticky navigation styles');
   const heading=summary.querySelector('h2');
   const badge=summary.querySelector('span');
   check(badge.getBoundingClientRect().right>summary.getBoundingClientRect().right-3,'Status must align to right edge');
 }
 if (${reviewMode}) {
   check(!document.querySelector('button[value="rework"]')&&!document.querySelector('button[value="reject"]'),'Removed review actions must not render');
   const approve=document.querySelector('button[value="approve"]');
   const withEdits=document.querySelector('button[value="approve_with_edits"]');
   check(approve.classList.contains('wf-btn-primary')&&withEdits.classList.contains('wf-btn-ghost'),'Approval buttons must use theme styles');
   check([approve,withEdits].every(button=>button.getBoundingClientRect().height>=44&&getComputedStyle(button).fontSize==='14px'),'Approval buttons must use larger sizing');
   check(withEdits.form.getAttribute('id')==='inward-plan-editor','Approve with Edits must submit editor values');
   approve.click();await sleep(100);
   check(window.lastReview?.decision==='approve'&&!!window.lastReview.plan_id,'Approve must submit operation and plan identity');
 }
 const title=document.querySelector('input[name="title"]');
 check(title.readOnly&&title.value==='IP_Monthly_Oct_2026','Plan title must be automatically generated and read only');
 const periodSelect=document.querySelector('select[name="period_kind"]');
 const periodDate=document.querySelector('input[name="period_start"]');
 const planningFields=[title,periodSelect,periodDate].map(field=>field.getBoundingClientRect());
 check(Math.max(...planningFields.map(rect=>rect.top))-Math.min(...planningFields.map(rect=>rect.top))<1,'Plan title, period and date input top edges must align');
 check(Math.max(...planningFields.map(rect=>rect.height))-Math.min(...planningFields.map(rect=>rect.height))<1,'Planning inputs must have matching heights');
 periodSelect.value='weekly';periodSelect.dispatchEvent(new Event('change',{bubbles:true}));await sleep(30);
 setValue(document.querySelector('input[name="period_start"]'),'2026-10-26');await sleep(30);
 check(title.value==='IP_Weekly_26th Oct, 2026','Weekly title must follow selected date');
 periodSelect.value='monthly';periodSelect.dispatchEvent(new Event('change',{bubbles:true}));await sleep(30);
 check(title.value==='IP_Monthly_Oct_2026','Monthly title must update when cadence changes');
 const planRemarks=document.querySelector('textarea[name="remarks"]');
 Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype,'value').set.call(planRemarks,'Unsaved plan remarks');
 planRemarks.dispatchEvent(new Event('input',{bubbles:true}));await sleep(30);
 const url=location.href;
 const searchInput=document.querySelector('input[placeholder="Enter a product code or variant code"]');
 const searchForm=searchInput.form;
 const searchControls=[searchForm.querySelector('select'),searchInput,searchForm.querySelector('button')].map(control=>control.getBoundingClientRect());
 check(Math.max(...searchControls.map(rect=>rect.bottom))-Math.min(...searchControls.map(rect=>rect.bottom))<1,'Search controls bottom edges must align');
 check(Math.max(...searchControls.map(rect=>rect.top))-Math.min(...searchControls.map(rect=>rect.top))<1,'Search controls top edges must align');
 const searchOptions=[...searchForm.querySelector('select').options];
 check(searchOptions.map(option=>option.textContent).join('|')==='Product Code|Variant Code','Incorrect search choices');
 const matrix=document.querySelector('table[aria-label="inventory"]') || [...document.querySelectorAll('table')].find(t=>t.textContent.includes('Inventory Days on Hand'));
 check(!!matrix,'Inventory matrix missing');
 const metricRows=matrix.querySelectorAll('tbody tr');
 check(metricRows.length===3,'Expected three inventory metrics');
 check(metricRows[0].querySelectorAll('td')[1].textContent==='24','S stock incorrect');
 check(metricRows[1].querySelectorAll('td')[1].textContent==='3','S DOQ incorrect');
 check(metricRows[2].querySelectorAll('td')[1].textContent==='8','S DOH incorrect');
 check(metricRows[0].querySelectorAll('td')[0].textContent==='N/A','Missing size must be unavailable');
 const scrollRegion=matrix.parentElement;
 const clones=Array.from({length:30},()=>metricRows[2].cloneNode(true));
 clones.forEach(row=>matrix.querySelector('tbody').append(row));
 scrollRegion.scrollIntoView({block:'start'});await sleep(30);
 const headerTop=matrix.querySelector('thead th').getBoundingClientRect().top;
 scrollRegion.scrollTop=100;await sleep(30);
 check(scrollRegion.scrollTop>0&&scrollRegion.scrollHeight>scrollRegion.clientHeight,'Inventory does not scroll vertically');
 check(Math.abs(matrix.querySelector('thead th').getBoundingClientRect().top-headerTop)<2,'Inventory header moved while scrolling');
 for (const header of [...matrix.querySelectorAll('thead th')].slice(0,3)) {
   const rect=header.getBoundingClientRect();
   check(Math.abs(rect.top-headerTop)<2,'First three headers must remain sticky');
   check(document.elementFromPoint(rect.left+rect.width/2,rect.top+rect.height/2)===header,'Body labels must not cover column header '+header.textContent);
 }
 const rowLabel=matrix.querySelector('tbody th');
 check(getComputedStyle(rowLabel).position==='static','Body row labels must not stick vertically');
 check(getComputedStyle(rowLabel).fontSize===getComputedStyle(matrix.querySelector('tbody td')).fontSize,'Row labels and values must use same theme text size');
 clones.forEach(row=>row.remove());scrollRegion.scrollTop=0;
 document.querySelector('button[aria-haspopup="dialog"]').click(); await sleep(30);
 check(document.querySelector('dialog').open,'PO popup did not open');
 const popupRect=document.querySelector('dialog').getBoundingClientRect();
 check(Math.abs(popupRect.left+popupRect.width/2-document.documentElement.clientWidth/2)<2,'PO popup must be horizontally centered');
 check(Math.abs(popupRect.top+popupRect.height/2-document.documentElement.clientHeight/2)<2,'PO popup must be vertically centered');
 check(popupRect.left>=0&&popupRect.right<=innerWidth&&popupRect.top>=0&&popupRect.bottom<=innerHeight,'PO popup must fit within viewport');
 const poTable=document.querySelector('dialog table');
 check(poTable.querySelectorAll('thead th').length===14,'PO table size columns missing');
 check([...poTable.querySelectorAll('tbody td')].every(cell=>getComputedStyle(cell).verticalAlign==='middle'),'PO row cells must align vertically in the middle');
 check(poTable.querySelector('button').className===document.querySelector('button[aria-haspopup="dialog"]').className,'Add and View PO Detail must use identical theme classes');
 const rowCells=[...poTable.querySelector('tbody tr').children];
 const buttonRect=poTable.querySelector('button').getBoundingClientRect();
 const buttonCenter=buttonRect.top+buttonRect.height/2;
 for (const cell of rowCells.slice(0,-1)) {
   const range=document.createRange();range.selectNodeContents(cell.firstElementChild);
   const textRect=range.getBoundingClientRect();
   check(Math.abs(textRect.top+textRect.height/2-buttonCenter)<2,'Actual row text and button centers must align: '+cell.textContent);
 }

 check(poTable.querySelector('tbody tr').children[5].textContent==='100','S pending quantity wrong');
 check(poTable.querySelector('tbody tr').children[1].textContent==='2026-10-28','Delivery date missing');
 document.querySelector('button[aria-label="Add to Inward Plan from PO-1"]').click();
 await sleep(80);
 check(document.querySelectorAll('input[aria-label^="Quantity for line"]').length===1,'Add did not append a schedule row');
 const schedule=[...document.querySelectorAll('table')].find(table=>table.querySelector('caption')?.textContent==='Editable receipt schedule');
 check([...schedule.querySelectorAll('thead th')].map(th=>th.textContent).join('|')==='PO No|Vendor Name|Product Code|Expected Inward Date|Quantity|Cost/piece|Remarks|Remove','Schedule columns differ from requested layout');
 const row=schedule.querySelector('tbody tr');
 check(row.children[0].textContent.includes('REF-1')&&row.children[1].textContent==='Vendor'&&row.children[2].textContent.includes('SD'),'Schedule source details missing');
 check(window.saveCalls===0&&location.href===url,'Add submitted or navigated');
 const payload=JSON.parse(document.querySelector('input[name="lines"]').value);
 check(payload.length===1&&payload[0].planning_level==='product'&&payload[0].po_detail_id==='','Product add must not split SKU rows');
 check(payload[0].po_number==='PO-1'&&payload[0].product_code==='SD','Missing product identity');
 check(document.activeElement===document.querySelector('input[aria-label="Quantity for line 1"]'),'Added row was not brought into focus');
 const quantity=document.querySelector('input[aria-label="Quantity for line 1"]');
 setValue(quantity,'7'); await sleep(30);
 const enter=new KeyboardEvent('keydown',{key:'Enter',bubbles:true,cancelable:true});
 quantity.dispatchEvent(enter); await sleep(30);
 check(enter.defaultPrevented&&window.saveCalls===0,'Enter in quantity must not submit the save form');

 document.querySelector('input[placeholder="Enter a product code or variant code"]').form.requestSubmit();
 await sleep(100);
 check(window.searchCalls===1,'Search must issue one read request');
 check(document.querySelector('textarea[name="remarks"]').value==='Unsaved plan remarks','Search cleared the plan title');
 check(document.querySelector('input[aria-label="Quantity for line 1"]').value==='7','Search cleared entered quantity');
 check(window.saveCalls===0&&location.href===url,'Search saved or navigated');
 window.fetch=async()=>{throw Error('Offline search');};
 document.querySelector('input[placeholder="Enter a product code or variant code"]').form.requestSubmit();
 await sleep(100);
 check(document.body.textContent.includes('Offline search'),'Search error not displayed');
 document.querySelector('button[aria-haspopup="dialog"]').click(); await sleep(30);
 check(document.querySelector('textarea[name="remarks"]').value==='Unsaved plan remarks','Failed search cleared draft');
 document.querySelector('button[aria-label="Add to Inward Plan from PO-1"]').click();
 await sleep(80);
 check(document.querySelectorAll('input[aria-label^="Quantity for line"]').length===2,'Failed search removed existing Add choices');
 check(document.activeElement===document.querySelector('input[aria-label="Quantity for line 2"]'),'Second Add did not focus new quantity');
 document.querySelector('button[aria-label="Remove line 1"]').click(); await sleep(50);
 check(document.querySelectorAll('input[aria-label^="Quantity for line"]').length===1,'Remove did not remove exactly one row');
 check(window.errors.length===0,'Browser runtime error: '+window.errors.join(','));
 setValue(document.querySelector('input[aria-label="Quantity for line 1"]'),'3'); await sleep(30);
 document.querySelector('button[type="submit"].wf-btn-primary').click(); await sleep(100);
 check(window.saveCalls===1,'Explicit Save did not invoke save action exactly once');
 if (${reviewMode}) {
   const notes=document.querySelector('textarea[name="notes"]');
   Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype,'value').set.call(notes,'Reviewed with quantity changes');
   notes.dispatchEvent(new Event('input',{bubbles:true}));await sleep(30);
   setValue(document.querySelector('input[aria-label="Quantity for line 1"]'),'4');await sleep(30);
   check(document.querySelector('button[value="approve"]').disabled,'Approve saved values must be disabled with unsaved edits');
   const withEdits=document.querySelector('button[value="approve_with_edits"]');
   check(!withEdits.disabled,'Approve with Edits must allow unsaved edits');
   withEdits.click();await sleep(100);
   check(window.saveCalls===2&&window.lastSave.intent==='approve_with_edits','Approve with Edits must invoke editor save action');
   check(JSON.parse(window.lastSave.lines)[0].inward_qty==='4'&&window.lastSave.approval_notes==='Reviewed with quantity changes','Edits and review notes must be submitted together');
 }

 document.getElementById('result').textContent=JSON.stringify({ok:true,checks:window.checks,errors:window.errors});
}
run().catch(error=>document.getElementById('result').textContent=JSON.stringify({ok:false,error:error.message,checks:window.checks}));
`;
const bundled=await build({stdin:{contents:entry,resolveDir:resolve('.'),loader:'tsx'},bundle:true,write:false,
 format:'iife',platform:'browser',jsx:'automatic',define:{'process.env.NODE_ENV':'"production"'},
 plugins:[{name:'isolate-actions',setup(plugin){
 plugin.onResolve({filter:/^\.\/actions$/},args=>args.importer.endsWith('workspace.tsx')?{path:'actions',namespace:'test-actions'}:undefined);
 plugin.onLoad({filter:/.*/,namespace:'test-actions'},()=>({contents:`
 export async function savePlan(previous,form){window.saveCalls++;window.lastSave=Object.fromEntries(form);return {ok:false,message:'Isolated save stub'};}
 export async function reviewPlan(previous,form){window.lastReview=Object.fromEntries(form);return {ok:false,message:''};}
 export async function validatePlan(){return {ok:true,message:''};}
 export async function searchSources(){window.searchCalls++;return {rows:[${JSON.stringify(fixture)}]};}
 `,loader:'js'}));
 plugin.onLoad({filter:/\.module\.css$/},async args=>{
 const css=await readFile(args.path,'utf8');
 const classes=Object.fromEntries([...css.matchAll(/\.([a-zA-Z_][a-zA-Z0-9_-]*)/g)].map(match=>[match[1],match[1]]));
 return {contents:'const style=document.createElement("style");style.textContent='+JSON.stringify(css)+';document.head.append(style);export default '+JSON.stringify(classes)+';',loader:'js'};
 });
 }}]});
const directory=await mkdtemp(join(tmpdir(),'inward-v2-editor-'));
await writeFile(join(directory,'bundle.js'),bundled.outputFiles[0].text);
const globalCss=(await Promise.all(['globals.css','workflows.css','shopify-ui.css','search-bars.css','toolbar.css'].map(file=>readFile(resolve('src/app',file),'utf8')))).join('\n').replace(/^@import.*;$/gm,'');
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
console.log('PASS: '+report.checks+' headless-browser editor assertions on '+host+' ('+(plan?'saved draft':'new plan')+'); real React component, mocked network/actions.');
