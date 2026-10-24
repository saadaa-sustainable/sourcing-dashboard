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
import AnalyticsPage from './src/app/inward-plan-v2/analytics/page';
window.errors=[];window.addEventListener('error',e=>window.errors.push(e.message));
const check=(value,label)=>{if(!value)throw Error(label);window.checks=(window.checks||0)+1;};
async function run(){
 const monthly=await AnalyticsPage({searchParams:Promise.resolve({cadence:'monthly',start:'2026-10-01'})});
 const weekly=await AnalyticsPage({searchParams:Promise.resolve({cadence:'weekly',start:'2026-10-26'})});
 createRoot(document.getElementById('root')).render(<div className="wf-page"><div id="monthly">{monthly}</div><div id="weekly">{weekly}</div></div>);
 await new Promise(resolve=>setTimeout(resolve,100));
 for (const cadence of ['monthly','weekly']) {
   const view=document.getElementById(cadence);
   const sections=view.querySelectorAll('main > section');
   check(sections.length===1,'Analytics must have one outer section: '+cadence);
   const section=sections[0];
   check(section.getAttribute('aria-label')===(cadence==='monthly'?'Monthly analytics':'Weekly analytics'),'Outer section must reflect cadence');
   const tabs=section.querySelector('nav[aria-label="Analytics baseline"]');
   check(tabs.querySelectorAll('a').length===2&&tabs.querySelectorAll('[aria-current="page"]').length===1,'Exactly one cadence must be selected');
   const active=tabs.querySelector('[aria-current="page"]');
   check(active.textContent.toLowerCase()===cadence,'Wrong cadence selected');
   check(active.classList.contains('wf-btn-primary'),'Selected period must explicitly use primary theme styling');
   const inactive=tabs.querySelector('a:not([aria-current])');
   check(inactive.classList.contains('wf-btn-ghost'),'Other period must explicitly use outlined theme styling');
   const tabRects=[...tabs.querySelectorAll('a')].map(tab=>tab.getBoundingClientRect());
   check(tabRects[1].left>tabRects[0].right,'Period tabs must have a visible gap');
   check(getComputedStyle(active).backgroundColor==='rgb(23, 23, 23)','Selected tab must be visibly highlighted');
   check(section.querySelectorAll('.metrics > div').length===6,'Metrics must stay inside section');
   check(section.querySelectorAll('h2').length===2&&!!section.querySelector('table'),'Chart and reconciliation must stay inside section');
   check(section.querySelector('form input[name="cadence"]').value===cadence,'Period filter must preserve selected cadence');
   const dateRect=section.querySelector('form input[type="date"]').getBoundingClientRect();
   const buttonRect=section.querySelector('form button').getBoundingClientRect();
   check(Math.abs(dateRect.top-buttonRect.top)<1&&Math.abs(dateRect.bottom-buttonRect.bottom)<1,'Date and View period button must align '+JSON.stringify({date:dateRect.toJSON(),button:buttonRect.toJSON()}));
 }
 check(window.errors.length===0,'Browser runtime error');
 document.getElementById('result').textContent=JSON.stringify({ok:true,checks:window.checks});
}
run().catch(error=>document.getElementById('result').textContent=JSON.stringify({ok:false,error:error.message,checks:window.checks}));
`;
const bundled=await build({stdin:{contents:entry,resolveDir:resolve('.'),loader:'tsx'},bundle:true,write:false,format:'iife',platform:'browser',jsx:'automatic',define:{'process.env.NODE_ENV':'"production"'},plugins:[{name:'isolate-reporting',setup(plugin){
 plugin.onResolve({filter:/^next\/(link|navigation)$/},args=>({path:args.path,namespace:'mock'}));
 plugin.onResolve({filter:/^(?:@\/lib\/inward-plan-v2\/(?:server|grn-server)|\.\.\/reporting-shell|@\/components\/forms\/form-layout)$/},args=>({path:args.path,namespace:'mock'}));
 plugin.onLoad({filter:/.*/,namespace:'mock'},args=>{
 let contents;
 if(args.path==='next/link') contents='import React from "react";export default function Link({children,...props}){return React.createElement("a",props,children);}';
 else if(args.path==='next/navigation') contents='export const redirect=()=>{throw Error("Unexpected redirect")};';
 else if(args.path.endsWith('/grn-server')) contents='export const loadGrnData=async()=>({plans:[],lines:[],reports:[],reconciliations:[],receipts:[]});';
 else if(args.path.endsWith('/server')) contents='export class V2SignInRequired extends Error{};export const context=async()=>({role:"viewer",email:"viewer@saadaa.in",allowedPages:null});';
 else if(args.path.endsWith('reporting-shell')) contents='import React from "react";export function ReportingShell({children}){return React.createElement("main",null,children)}';
 else contents='import React from "react";export function Notice({children}){return React.createElement("div",null,children)}';
 return {contents,loader:'js',resolveDir:resolve('.')};
 });
 plugin.onLoad({filter:/\.module\.css$/},async args=>{
 const css=(await readFile(args.path,'utf8')).replace(/:global\(([^)]+)\)/g,'$1');
 const classes=Object.fromEntries([...css.matchAll(/\.([a-zA-Z_][a-zA-Z0-9_-]*)/g)].map(match=>[match[1],match[1]]));
 return {contents:'const style=document.createElement("style");style.textContent='+JSON.stringify(css)+';document.head.append(style);export default '+JSON.stringify(classes)+';',loader:'js'};
 });
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
console.log('PASS: '+report.checks+' analytics tabs/layout browser assertions.');
