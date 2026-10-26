// Real editor + CSS in an isolated browser. Save actions are mocked; no live writes.
// npm exec --yes --package=playwright -- node scripts/test-material-plan-input-browser.mjs
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { readFile, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, delimiter, resolve } from 'node:path';
import { build } from 'esbuild';
const require = createRequire(import.meta.url);
let playwright;
for (const bin of process.env.PATH.split(delimiter)) {
  try { playwright = require(join(bin, '..', 'playwright')); break; } catch {}
}
if (!playwright) throw new Error('Run this script through npm exec --package=playwright.');
const directory = await mkdtemp(join(tmpdir(), 'material-plan-browser-'));
const mocks = {
  '@/lib/forms/actions': `
    export async function saveBuyingPlan(form) {
      window.savedPayload = JSON.parse(form.get('lines'));
      if (window.throwSave) throw new Error('Test network failure');
      return window.failSave ? {ok:false,error:'Test save failed'} : {ok:true,message:'Saved.'};
    }
    export const submitBuyingPlan = async () => ({ok:true});
    export const approveBuyingPlanLines = submitBuyingPlan, editAndApprovePlanLines = submitBuyingPlan,
      rejectBuyingPlanLines = submitBuyingPlan, reworkLines = submitBuyingPlan;
  `,
  '@/lib/toast': `export const reloadWithToast = () => {window.reloaded=true}; export const toastError = (message) => message;`,
  '@/components/forms/form-layout': `
    import React from 'react';
    export const Notice = ({children}) => <div className="wf-notice" role="status">{children}</div>;
    export const StatusBadge = ({status}) => <span>{status}</span>;
  `,
  'next/link': `import React from 'react'; export default function Link({children,...props}) { return <a {...props}>{children}</a> }`,
  'next/navigation': `export const usePathname=()=>'/buying-plan'; export const useRouter=()=>({push(){},replace(){},refresh(){}}); export const useSearchParams=()=>new URLSearchParams();`,
};
const now = new Date();
const ist = new Date(now.getTime() + 19800000);
const month = `${ist.getUTCFullYear()}-${String(ist.getUTCMonth()+1).padStart(2,'0')}-01`;
const bundle = await build({
  stdin: { contents: `
    import React from 'react';
    import {createRoot} from 'react-dom/client';
    import {MaterialPlanClient} from './src/app/buying-plan/material-plan-client';
    const props = ${JSON.stringify({
      planMonth: month, plan: { id: 123, status: 'draft', plan_month: month, plan_type: 'material' },
      lines: [], colours: [], role: 'team', startInInput: true,
      materialCodes: [
        { material_code: '60CT/48/RM', material_type: 'raw', fabric_name: 'Cambric cotton', colour: 'GREIGE', base_fabric_code: null },
        { material_code: '60CT/48/BL', material_type: 'dyed', fabric_name: 'Cambric cotton', colour: 'BLACK', base_fabric_code: null },
      ], materialCosts: { '60CT/48/RM': { job: 10, fob: 20 } },
    })};
    createRoot(document.getElementById('app')).render(<MaterialPlanClient {...props}/>);
  `, loader: 'tsx', resolveDir: process.cwd() },
  bundle: true, write: false, jsx: 'automatic', platform: 'browser',
  define: { 'process.env.NODE_ENV': '"development"' },
  plugins: [{ name: 'mock-server-boundaries', setup(builder) {
    builder.onResolve({ filter: /.*/ }, (args) => args.path in mocks ? {path:args.path,namespace:'mock'} : undefined);
    builder.onLoad({filter:/.*/,namespace:'mock'}, (args) => ({contents:mocks[args.path],loader:'tsx',resolveDir:process.cwd()}));
  } }],
});
const css = (await Promise.all(['globals.css','workflows.css','buying-plan.css','shopify-ui.css']
  .map((file) => readFile(resolve('src/app',file),'utf8')))).join('\n');
const browser = await playwright.chromium.launch({ executablePath:'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',headless:true });
try {
  const page = await browser.newPage({viewport:{width:1500,height:1100}});
  const errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.setContent('<div class="ui-shopify ui-view-buying-plan"><div id="app" style="padding:16px"></div></div>');
  await page.addStyleTag({content:css});
  await page.addScriptTag({content:bundle.outputFiles[0].text});
  const input = page.getByRole('combobox',{name:'Search material code'});
  await input.fill('cambric');
  await page.getByRole('option').filter({hasText:'60CT/48/RM'}).click();
  await page.getByLabel('New material Job Work quantity',{exact:true}).fill('1');
  await page.getByLabel('New material Purchase quantity',{exact:true}).fill('2');
  await page.getByLabel('New material remark',{exact:true}).fill('save the default row');
  const editor = page.locator('.bp-material-editor');
  await editor.locator('.bp-input-footer').getByText(/1 planned line/).waitFor();
  const rowHeight = await editor.locator('tbody tr').first().evaluate((row) => row.getBoundingClientRect().height);
  const inputHeight = await page.getByLabel('New material Job Work quantity',{exact:true}).evaluate((input) => input.getBoundingClientRect().height);
  assert.ok(rowHeight <= 44, `Compact row should be at most 44px, got ${rowHeight}`);
  assert.equal(inputHeight, 32);
  const alignment = await editor.locator('.bp-material-input-grid').evaluate((table) => ({
    width: table.getBoundingClientRect().width,
    available: table.parentElement.clientWidth,
    headers: [...table.querySelectorAll('th')].map((cell) => getComputedStyle(cell).textAlign),
    fields: [...table.querySelectorAll('tbody td:not(:first-child) input,tbody td:not(:first-child) select')].map((input) => getComputedStyle(input).textAlign),
  }));
  assert.ok(Math.abs(alignment.width-alignment.available)<2, 'Table fills available desktop width');
  assert.equal(alignment.headers[0], 'left');
  assert.ok(alignment.headers.slice(1).every((value) => value==='center'));
  assert.ok(alignment.fields.every((value) => value==='center'));
  const widths = await page.locator('.bp-material-type-tabs > button').evaluateAll((buttons) => buttons.map((b) => b.getBoundingClientRect().width));
  assert.ok(Math.max(...widths)-Math.min(...widths)<2, 'All three tabs must have equal width');
  await page.screenshot({path:join(directory,'desktop.png'),fullPage:true});
  // Error leaves both code and quantities intact for retry.
  await page.evaluate(() => {window.failSave=true});
  await page.getByRole('button',{name:'Save draft',exact:true}).first().click();
  await page.getByText('Test save failed',{exact:true}).waitFor();
  assert.equal(await input.inputValue(),'60CT/48/RM');
  assert.equal(await page.getByLabel('New material Job Work quantity',{exact:true}).inputValue(),'1');
  assert.equal(await page.evaluate(() => window.savedPayload[0].job_work_qty),'1');
  await page.evaluate(() => {window.failSave=false;window.throwSave=true});
  await page.getByRole('button',{name:'Save draft',exact:true}).first().click();
  await page.getByText('Test network failure',{exact:true}).waitFor();
  assert.equal(await page.getByLabel('New material Purchase quantity',{exact:true}).inputValue(),'2');
  // Success commits the default row and resets the add row, without clicking Add row.
  await page.evaluate(() => {window.failSave=false;window.throwSave=false});
  await page.getByRole('button',{name:'Save draft',exact:true}).last().click();
  await page.waitForFunction(() => window.reloaded===true);
  const saved = await page.evaluate(() => window.savedPayload);
  assert.equal(saved.length,1);
  assert.deepEqual(saved[0], {product_code:'60CT/48/RM',material_type:'raw',colour:'',job_work_qty:'1',fob_qty:'2',uom:'metres',remark:'save the default row'});
  assert.equal(await input.inputValue(),'');
  await editor.locator('tbody tr').filter({hasText:'60CT/48/RM'}).waitFor();
  // A second save must not duplicate the committed row.
  await page.getByRole('button',{name:'Save draft',exact:true}).first().click();
  assert.equal((await page.evaluate(() => window.savedPayload)).length,1);
  await page.setViewportSize({width:390,height:844});
  await page.screenshot({path:join(directory,'mobile.png'),fullPage:true});
  const mobileWidths=await page.locator('.bp-material-type-tabs > button').evaluateAll((buttons)=>buttons.map((b)=>b.getBoundingClientRect().width));
  assert.ok(Math.max(...mobileWidths)-Math.min(...mobileWidths)<2);
  await page.setViewportSize({width:1500,height:1100});
  await page.getByRole('button',{name:'View',exact:true}).click();
  const overview = page.locator('.bp-material-overview');
  await overview.getByRole('heading',{name:/^Plan overview/}).waitFor();
  await overview.getByRole('textbox',{name:'Search material',exact:true}).waitFor();
  await overview.getByRole('heading',{name:/^Material plan by material type/}).waitFor();
  assert.equal(await overview.locator('.bp-card').count(),0,'Overview, filters and grouped plan share one card');
  await overview.getByRole('textbox',{name:'Search material',exact:true}).fill('does-not-exist');
  await overview.getByText('No lines match the filters.',{exact:true}).waitFor();
  await overview.getByRole('textbox',{name:'Search material',exact:true}).fill('');
  await overview.getByRole('button',{name:'Collapse all',exact:true}).click();
  assert.equal(await overview.locator('.bp-skurow').count(),0);
  await overview.getByRole('button',{name:'Expand all',exact:true}).click();
  assert.equal(await overview.locator('.bp-skurow').count(),1);
  await page.screenshot({path:join(directory,'merged-overview.png'),fullPage:true});
  assert.equal(errors.length,0,errors.join('\n'));
  await writeFile(join(directory,'result.json'),JSON.stringify({saved, widths, mobileWidths, errors},null,2));
  console.log(JSON.stringify({passed:true,savePayload:saved,desktopTabWidths:widths,mobileTabWidths:mobileWidths,artifacts:directory,liveWrites:0}));
} finally {await browser.close()}
