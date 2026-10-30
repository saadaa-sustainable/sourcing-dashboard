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
const directory = await mkdtemp(join(tmpdir(), 'fg-plan-browser-'));
const mocks = {
  '@/lib/forms/actions': `
    export async function saveBuyingPlan(form) {
      window.savedPayload = JSON.parse(form.get('lines'));
      if (window.throwSave) throw new Error('Test network failure');
      return window.failSave ? {ok:false,error:'Test save failed'} : {ok:true,message:'Saved.'};
    }
    export const submitBuyingPlan = async () => ({ok:true}); export const requestPlanAmendment=submitBuyingPlan, saveAnalyticsRule=submitBuyingPlan;
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
    import {BuyingPlanClient} from './src/app/buying-plan/buying-plan-client';
    const props = ${JSON.stringify({
      planMonth: month, plan: { id: 123, status: 'draft', plan_month: month, plan_type: 'fg' },
      lines: [{id:1, product_code:'TEST-FG',job_work_qty:2,efob_qty:0,fob_qty:1,remark:'',line_status:null}],
      productCodes: ['TEST-FG','TEST-NEW','TEST-THIRD'], productMaster: {'TEST-FG':{status:'Active',fabric_type:'Woven'}},
      standardCosts: {'TEST-FG':{job:10,efob:20,fob:30}}, pendingByCode: {}, actuals: {}, role:'team',
    })};
    createRoot(document.getElementById('app')).render(<BuyingPlanClient {...props}/>);
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
  const workspace=page.locator('.bp-fg-workspace');
  await page.getByRole('heading',{name:/Plan overview/}).waitFor();
  assert.equal(await workspace.locator('.bp-fg-overview').count(),1);
  assert.equal(await page.getByRole('heading',{name:/Plan detail/}).count(),0);
  assert.equal(await page.getByRole('combobox',{name:'Group by',exact:true}).count(),0);
  const groups=workspace.locator('.bp-fg-overview > .bp-card').last();
  assert.equal(await groups.getByRole('textbox',{name:'Search product code'}).count(),1);
  const edit=page.getByRole('button',{name:'Edit and submit for approval',exact:true});
  assert.equal(await edit.evaluate(b=>getComputedStyle(b).backgroundColor),'rgb(235, 235, 235)');
  await page.screenshot({path:join(directory,'view.png'),fullPage:true});
  await edit.click();
  await page.getByRole('heading',{name:/Bulk Upload or Manually Enter Buying Plan/}).waitFor();
  assert.equal(await page.getByRole('button',{name:'Download Plan Template',exact:true}).count(),1);
  assert.equal(await page.getByRole('button',{name:'Import Plan CSV',exact:true}).count(),1);
  assert.equal(await page.getByRole('button',{name:'Save draft',exact:true}).count(),1);
  assert.equal(await page.getByRole('button',{name:'Submit for approval',exact:true}).count(),1);
  const editor=page.locator('.bp-material-editor');
  assert.equal(await editor.getByRole('button',{name:'Kanban',exact:true}).count(),0);
  const selector=page.getByRole('combobox',{name:'Search product code',exact:true});
  assert.equal(await selector.count(),1);
  assert.equal(await editor.getByRole('textbox',{name:'Search product code',exact:true}).count(),0);
  assert.equal(await editor.locator('tbody tr').count(),2);
  await selector.fill('TEST-NEW');
  await page.getByRole('option').filter({hasText:'TEST-NEW'}).click();
  const newRow=editor.locator('tbody tr').filter({has:selector});
  await newRow.locator('input[type=number]').first().fill('5');
  await newRow.locator('input[placeholder=optional]').fill('inline entry');
  // Saving directly includes the selected default row, without clicking Add.
  await page.evaluate(()=>{window.failSave=true});
  await page.getByRole('button',{name:'Save draft',exact:true}).click();
  await page.getByText('Test save failed',{exact:true}).waitFor();
  assert.equal(await selector.inputValue(),'TEST-NEW');
  assert.equal(await newRow.locator('input[type=number]').first().inputValue(),'5');
  const payload=await page.evaluate(()=>window.savedPayload);
  assert.equal(payload.length,2);
  assert.equal(payload[1].product_code,'TEST-NEW');
  assert.equal(payload[1].job_work_qty,'5');
  assert.equal(payload[1].remark,'inline entry');
  await page.evaluate(()=>{window.failSave=false});
  await page.getByRole('button',{name:'Save draft',exact:true}).click();
  await page.waitForFunction(()=>window.reloaded===true);
  await page.getByRole('button',{name:'Add product code row',exact:true}).click();
  assert.equal(await editor.locator('tbody tr').count(),3);
  const blank=page.getByRole('combobox',{name:'Search product code',exact:true}).last();
  await blank.click();
  assert.equal(await page.getByRole('option').filter({hasText:'TEST-NEW'}).count(),0);
  await page.keyboard.press('Escape');
  const positions=await editor.locator('.bp-input-footer').evaluate(f=>({summary:f.children[0].getBoundingClientRect().x,actions:f.children[1].getBoundingClientRect().x}));
  assert.ok(positions.actions<positions.summary);
  await page.screenshot({path:join(directory,'input.png'),fullPage:true});
  await page.setViewportSize({width:390,height:844});
  await page.screenshot({path:join(directory,'mobile.png'),fullPage:true});
  assert.deepEqual(errors,[]);
  console.log(JSON.stringify({ok:true,directory}));
} finally { await browser.close(); }
