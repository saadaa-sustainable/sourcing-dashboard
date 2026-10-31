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
import React from 'react';import {createRoot} from 'react-dom/client';import {PoCadPlans} from './src/app/po-approval/po-cad-plans';
window.documents=[];window.starts=0;window.uploads=0;window.opened=null;
window.open=()=>({opener:{},location:{set href(v){window.opened=v;}},close(){}});
const root=createRoot(document.getElementById('root'));
window.mount=(id=1,editable=true,key='default')=>root.render(<div className="wf-page"><div className="poa-drawer"><fieldset disabled={!editable}><PoCadPlans key={key} poId={id} editable={editable} required={editable}/></fieldset></div></div>);
let checks=0;const check=(v,m)=>{if(!v)throw Error(m);checks++;};const sleep=ms=>new Promise(r=>setTimeout(r,ms));
const value=(el,v)=>{Object.getOwnPropertyDescriptor(el.tagName==='SELECT'?HTMLSelectElement.prototype:HTMLInputElement.prototype,'value').set.call(el,v);el.dispatchEvent(new Event(el.tagName==='SELECT'?'change':'input',{bubbles:true}));};
const choose=(name='CAD.pdf')=>{const input=document.querySelector('input[type=file]');const transfer=new DataTransfer();transfer.items.add(new File(['%PDF-fixture'],name,{type:'application/pdf'}));input.files=transfer.files;input.dispatchEvent(new Event('change',{bubbles:true}));};
async function run(){window.mount();await sleep(200);check(document.body.textContent.includes('No CAD plans attached.'),'Initial empty state');check(document.querySelector('h4 [aria-label=required]'),'Required marker shown');check(document.querySelector('input[type=file]').getAttribute('aria-required')==='true','Empty CAD upload marked required');check(document.body.textContent.includes('Required: attach at least one CAD plan PDF'),'Mandatory guidance');value(document.querySelector('select'),'full_layer');await sleep(50);value(document.querySelector('[aria-label="CAD fabric width"]'),'58');value(document.querySelector('[aria-label="CAD remark"]'),'Marker');await sleep(50);choose();await sleep(150);check(window.starts===1&&window.uploads===1,'Signed upload flow');check(window.lastInput.group==='full_layer'&&window.lastInput.width==='58','Group and width passed');check(window.lastInput.remark==='Marker','Remark persisted');check(document.querySelector('.poa-cad-open').textContent==='CAD.pdf','Attached file displayed');check(document.querySelector('input[type=file]').getAttribute('aria-required')==='false','Existing attachment satisfies upload requirement');check(document.body.textContent.includes('58 inches'),'Metadata displayed');document.querySelector('.poa-cad-open').click();await sleep(50);check(window.opened==='https://fixture.invalid/CAD.pdf','Private open URL');document.querySelector('[aria-label="Remove CAD.pdf"]').click();await sleep(50);check(!document.querySelector('.poa-cad-open'),'Remove updates attachment list');
choose('CAD.png');await sleep(50);check(window.starts===1,'Invalid type rejected before upload');check(document.querySelector('[role=alert]').textContent.includes('PDF'),'Invalid type feedback');value(document.querySelector('[aria-label="CAD fabric width"]'),'');await sleep(50);choose();await sleep(50);check(window.starts===1,'Full-layer width required');check(document.querySelector('[role=alert]').textContent.includes('width'),'Width error shown');value(document.querySelector('[aria-label="CAD fabric width"]'),'58');await sleep(50);choose();await sleep(100);check(window.starts===2,'Same PDF can be selected again');
check(getComputedStyle(document.querySelector('.poa-cad-heading h4')).fontSize==='14px','Theme heading size');check(getComputedStyle(document.querySelector('.poa-cad-required')).display==='inline','Required marker stays inline');const picker=document.querySelector('input[type=file]');check(getComputedStyle(document.querySelector('.poa-cad-file-button')).backgroundColor==='rgb(241, 242, 243)','Grey themed file button');const fileButton=document.querySelector('.poa-cad-file-button');check(fileButton.textContent==='Choose PDF','Clear upload button text');check(fileButton.querySelector('svg'),'Upload icon shown');check(Math.abs(fileButton.getBoundingClientRect().height-38)<1,'Upload button matches field height');check(Math.abs(fileButton.getBoundingClientRect().width-picker.getBoundingClientRect().width)<1,'File picker covers whole button');picker.focus();check(document.activeElement===picker,'Keyboard accessible file picker');const grid=document.querySelector('.poa-cad-upload-grid');const uploadRow=document.querySelector('.poa-cad-file-label');check([...grid.children].slice(0,3).map(label=>label.querySelector('select,input').getAttribute('aria-label')).join(',')==='CAD plan type,Upload CAD PDF File,CAD remark','Requested field order');check(document.querySelector('.poa-cad-file-label small').getBoundingClientRect().top>=picker.getBoundingClientRect().bottom,'Help text below upload');const meta=[...grid.children].slice(0,3).map(label=>label.querySelector('select,input'));if(innerWidth>650)check(Math.max(...meta.map(el=>el.getBoundingClientRect().top))-Math.min(...meta.map(el=>el.getBoundingClientRect().top))<1,'Metadata inputs align');
const controls=[...document.querySelectorAll('.poa-cad-upload-grid input,.poa-cad-upload-grid select')];check(controls.every(el=>Math.abs(el.getBoundingClientRect().height-38)<1),'Aligned 38px controls');check(document.querySelector('.poa-cad-plans').scrollWidth<=document.querySelector('.poa-cad-plans').clientWidth+1,'No upload panel overflow');
window.mount(1,false);await sleep(50);check(!document.querySelector('input[type=file]'),'Read-only hides upload');check(!document.querySelector('[aria-label="Remove CAD.pdf"]'),'Read-only hides remove');document.querySelector('.poa-cad-open').click();await sleep(50);check(window.opened==='https://fixture.invalid/CAD.pdf','Can open in disabled section');window.mount(null,true,'new');await sleep(50);check(document.querySelector('input[type=file]').disabled,'Unsaved order cannot upload');check(document.body.textContent.includes('Save the Order step'),'Unsaved order guidance');document.getElementById('result').textContent=JSON.stringify({ok:true,checks});}
run().catch(e=>document.getElementById('result').textContent=JSON.stringify({ok:false,error:e.message,checks}));`;
const bundled=await build({stdin:{contents:entry,resolveDir:resolve('.'),loader:'tsx'},bundle:true,write:false,format:'iife',platform:'browser',jsx:'automatic',define:{'process.env.NODE_ENV':'"production"'},plugins:[{name:'mock-po-cad',setup(p){p.onResolve({filter:/^\.\/po-cad-actions$/},()=>({path:'actions',namespace:'mock'}));p.onLoad({filter:/.*/,namespace:'mock'},()=>({contents:`
export async function loadPoCadDocuments(){return window.documents;}
export async function startPoCadUpload(id,input){window.starts++;window.lastInput=input;return {id:window.starts,path:id+'/file.pdf',token:'fixture'};}
export async function finishPoCadUpload(id){const i=window.lastInput;window.documents=[{id,po_id:1,file_name:i.name,file_path:'1/file.pdf',file_size:i.size,doc_group:i.group,width:i.width,remark:i.remark}];return true;}
export async function removePoCadDocument(id){window.documents=[];}
export async function openPoCadDocument(){return 'https://fixture.invalid/CAD.pdf';}
`,loader:'js'}));p.onResolve({filter:/^@\/lib\/supabase\/client$/},()=>({path:'storage',namespace:'mock-storage'}));p.onLoad({filter:/.*/,namespace:'mock-storage'},()=>({contents:"export const createClient=()=>({storage:{from:()=>({uploadToSignedUrl:async()=>{window.uploads++;return {error:null};}})}});",loader:'js'}));}}]});
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
  const child=spawn(browser,['--headless', ...(process.env.PO_CAD_MOBILE==='true'?['--window-size=520,844']:['--window-size=1440,1000']), '--disable-gpu','--no-first-run','--no-default-browser-check',
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
console.log('PASS: '+report.checks+' real PO CAD upload browser checks, mocked storage/actions.');
