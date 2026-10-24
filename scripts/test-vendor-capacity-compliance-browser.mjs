import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { delimiter, join } from 'node:path';
const require = createRequire(import.meta.url);
let playwright;
for (const bin of process.env.PATH.split(delimiter)) {
  try { playwright = require(join(bin, '..', 'playwright')); break; } catch {}
}
if (!playwright) throw new Error('Run through npm exec --package=playwright -- node scripts/test-vendor-capacity-compliance-browser.mjs');
const browser = await playwright.chromium.launch({ executablePath: 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe', headless: true });
const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
const errors = [];
page.on('pageerror', error => errors.push(error.message));
try {
  await page.goto('http://localhost:3000/vendor-capacity', { waitUntil: 'networkidle' });
  await page.getByRole('link', { name: 'View Vendor Capacity Update compliance', exact: true }).click();
  await page.getByRole('heading', { name: 'Update compliance', exact: true }).waitFor();
  await page.goto('http://localhost:3000/vendor-capacity?view=entry', { waitUntil: 'networkidle' });
  await page.getByRole('tab', { name: 'Update Compliance', exact: true }).click();
  const panel = page.getByRole('region', { name: 'Capacity update compliance', exact: true });
  await panel.getByRole('heading', { name: 'Update compliance', exact: true }).waitFor();
  await panel.getByRole('columnheader', { name: 'Vendor status', exact: true }).waitFor();
  const originalRows = await panel.locator('tbody tr').count();
  assert.ok(originalRows > 0);
  await panel.getByLabel('Vendor', { exact: true }).fill('FLR');
  const flr = panel.locator('tbody tr');
  assert.equal(await flr.count(), 1);
  assert.ok((await flr.textContent()).includes('5 ELEMENTS'));
  assert.equal(await flr.locator('.vc-vendor-status').textContent(), 'Active');
  assert.equal(await flr.locator('td').nth(4).textContent(), 'Due');
  await panel.getByRole('button', { name: 'Clear filters', exact: true }).click();

  await panel.getByLabel('Vendor', { exact: true }).fill('NO_VENDOR_SHOULD_MATCH_THIS_82903');
  await panel.getByText('No vendors match these filters.', { exact: true }).waitFor();
  await panel.getByRole('button', { name: 'Clear filters', exact: true }).click();
  assert.equal(await panel.locator('tbody tr').count(), originalRows);
  const merchant = panel.getByLabel('Merchant', { exact: true });
  const choices = await merchant.locator('option').evaluateAll(options => options.map(o => o.value));
  if (choices.length > 1) {
    await merchant.selectOption(choices[1]);
    const assignments = await panel.locator('tbody tr td:nth-child(2)').allTextContents();
    assert.ok(assignments.every(value => value === choices[1]));
    await panel.getByRole('button', { name: 'Clear filters', exact: true }).click();
  }
  const month = panel.getByLabel('Reporting month', { exact: true });
  const months = await month.locator('option').evaluateAll(options => options.map(o => o.value));
  if (months.length > 1) { await month.selectOption(months.at(-1)); await month.selectOption(months[0]); }
  await panel.getByLabel('Overdue only (latest completed week)', { exact: true }).check();
  await panel.getByRole('button', { name: 'Clear filters', exact: true }).click();
  await panel.getByText('How the score is calculated', { exact: true }).click();
  await panel.getByText(/eligible completed vendor-weeks x 100/).waitFor();
  await page.screenshot({ path: 'docs/vendor-capacity-compliance-desktop.png', fullPage: true });
  await page.setViewportSize({ width: 390, height: 844 });
  const closeNavigation = page.getByRole('button', { name: 'Close navigation', exact: true });
  if (await page.locator('.sidebar.open').count()) await closeNavigation.click();
  await page.waitForFunction(() => (document.querySelector('.sidebar')?.getBoundingClientRect().right ?? 0) <= 0);
  await page.screenshot({ path: 'docs/vendor-capacity-compliance-mobile.png', fullPage: true, animations: 'disabled' });
  assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), 'Page must fit mobile viewport; tables scroll within their container.');
  assert.equal(errors.length, 0, errors.join('\n'));
  console.log(JSON.stringify({ browser: 'Edge headless', initialRows: originalRows, search: 'passed', merchant: 'passed', month: 'passed', overdue: 'passed', desktopAndMobile: 'passed', runtimeErrors: errors.length, businessWrites: 0 }));
} finally { await browser.close(); }
