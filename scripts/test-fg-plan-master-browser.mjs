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
// Read-only integration check against the running local app: selection only, no save.
const browser=await playwright.chromium.launch({executablePath:'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',headless:true});
try {
 const page=await browser.newPage({viewport:{width:1500,height:1000}});
 await page.goto('http://localhost:3000/buying-plan?month=2026-11-01&type=fg&mode=input');
 const selector=page.getByRole('combobox',{name:'Search product code',exact:true}).last();
 await selector.fill('SDAFD');
 await page.getByRole('option').filter({hasText:'SDAFD'}).first().click();
 const row=page.locator('.bp-fg-input-grid tbody tr').filter({has:selector});
 const cells=await row.locator('td').allTextContents();
 assert.equal(cells[1],'Dress');
 assert.equal(cells[2],'Ongoing');
 assert.equal(cells[3],'Woven');
 await page.screenshot({path:join(directory,'master-data.png'),fullPage:true});
 console.log(JSON.stringify({ok:true,category:cells[1],state:cells[2],weave:cells[3],directory}));
} finally {await browser.close();}

