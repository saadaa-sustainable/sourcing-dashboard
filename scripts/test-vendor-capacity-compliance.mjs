import assert from 'node:assert/strict';
import vm from 'node:vm';
import ts from 'typescript';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const compile = (file, resolve) => {
  const exports = {};
  vm.runInNewContext(ts.transpileModule(readFileSync(file, 'utf8'), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX, esModuleInterop: true } }).outputText, { exports, require: resolve, console, Date, Set, Map, Promise, Buffer });
  return exports;
};
const business = compile('src/lib/business-logic.ts', () => ({}));
const approval = compile('src/lib/forms/approval.ts', () => ({}));
const metrics = compile('src/lib/vendor-capacity-compliance.ts', name => name === './business-logic' ? business : approval);
const shared = compile('src/lib/forms/queries-modules/_shared.ts', () => ({}));
const loader = compile('src/lib/vendor-capacity-compliance-server.ts', name => {
  if (name === 'react') return { cache: f => f };
  if (name.endsWith('/_shared')) return shared;
  if (name.endsWith('/business-logic')) return business;
  if (name === './vendor-capacity-compliance') return metrics;
  return {};
});
if (process.argv.includes('--live')) {
  const env = readFileSync('.env.local', 'utf8');
  const value = key => { const line = env.split(/\r?\n/).find(l => l.startsWith(key + '=')); return line ? line.slice(key.length + 1).trim().replace(/^['"]|['"]$/g, '') : ''; };
  const { createClient } = require('@supabase/supabase-js');
  const db = createClient(value('NEXT_PUBLIC_SUPABASE_URL'), value('SUPABASE_SERVICE_ROLE_KEY'), { auth: { persistSession: false, autoRefreshToken: false } });
  const input = await loader.readComplianceInput(db);
  const month = new Date(Date.parse(input.now) + 5.5 * 3600000).toISOString().slice(0, 7) + '-01';
  const report = metrics.buildComplianceMonth(input, month);
  console.log(JSON.stringify({ readOnly: true, masters: input.masters.length, coverageStart: input.coverageStart, month, totals: metrics.complianceTotals(report.rows) }));
  process.exit(0);
}
let failed = false;
const requests = [];
const capacity = (code, at, karigar = 0) => ({ vendor_code: code, machines_allocated: 10, active_karigar: karigar, entry_date: at });
const tables = {
  vendor_master_data: [{ vendor_code: 'V1', vendor_name: 'Test Vendor', merchant_name: 'Merchant', is_active: true, ee_status: 'active', onboarding_date: null }],
  vendor_type_master: [],
  sd_vendor_capacity_log: [capacity('V1', '2026-10-20T06:00:00Z')],
  sd_vendor_deboarding_request: [],
  sd_vendor_in_process_weekly: [],
  sd_analytics_rule: [],
  sd_audit_log: [
    { id: 1, table_name: 'vendor_master_data', changed_at: '2026-10-01T06:00:00Z', op: 'UPDATE', before: { vendor_code: 'V1', ee_status: 'active', is_active: true }, after: { vendor_code: 'V1', ee_status: 'active', is_active: true } },
    ...Array.from({ length: 1501 }, (_, i) => ({ id: i + 2, table_name: 'sd_vendor_capacity_log', changed_at: '2026-10-02T06:00:00Z', op: 'UPDATE', before: null, after: capacity('V1', i < 1500 ? '2026-10-06T06:00:00Z' : '2026-10-13T06:00:00Z') })),
    { id: 1504, table_name: 'sd_vendor_capacity_log', changed_at: '2026-10-13T06:00:00Z', op: 'UPDATE', before: null, after: { vendor_code: 'V1', machines_allocated: -1, active_karigar: 20, entry_date: '2026-10-13T06:00:00Z' } },
  ],
};
const db = { from(table) {
  let ordered = false;
  const q = { select() { return q; }, in() { return q; }, eq() { return q; }, order() { ordered = true; return q; },
    async range(from, to) { assert.ok(ordered); requests.push({ table, from }); return failed && table === 'sd_audit_log' && from >= 1000 ? { data: null, error: { message: 'later page failed' } } : { data: tables[table].slice(from, to + 1), error: null }; } };
  return q;
} };
const input = await loader.readComplianceInput(db, '2026-10-24T12:00:00Z');
assert.equal(input.coverageStart, '2026-10-05');
assert.ok(requests.some(r => r.table === 'sd_audit_log' && r.from === 1000));
const report = metrics.buildComplianceMonth(input, '2026-10-01');
assert.equal(report.rows[0].updated, 2); assert.equal(report.rows[0].score, 100);
assert.equal(report.rows[0].currentWeek, 'updated');
assert.equal(input.updates.filter(u => u.at === '2026-10-13T06:00:00Z').length, 1);
failed = true;
await assert.rejects(() => loader.readComplianceInput(db), /later page failed/);
const React = require('react');
const { renderToStaticMarkup } = require('react-dom/server');
const view = compile('src/app/vendor-capacity/vendor-capacity-compliance-view.tsx', name => name === '@/lib/vendor-capacity-compliance' ? metrics : require(name));
const markup = renderToStaticMarkup(React.createElement(view.CapacityComplianceView, { reports: [report] }));
for (const text of ['Update compliance', 'eligible completed vendor-weeks x 100', 'Monthly compliance', 'This week update coverage', 'Overdue vendors', 'Reporting month', 'Merchant', 'Test Vendor', '100%', 'Monday-Sunday']) assert.ok(markup.includes(text), text);
assert.ok(!markup.includes('This week?s'));
const visibility = structuredClone(report);
visibility.rows.push({ ...visibility.rows[0], code: 'STALE', name: 'Hidden Inactive Vendor', vendorStatus: 'inactive', currentWeek: 'not-required', lastUpdated: '2026-10-18T18:29:59Z' });
visibility.rows.push({ ...visibility.rows[0], code: 'RECENT', name: 'Recent Inactive Vendor', vendorStatus: 'inactive', currentWeek: 'not-required', lastUpdated: '2026-10-18T18:30:00Z' });
const filteredMarkup = renderToStaticMarkup(React.createElement(view.CapacityComplianceView, { reports: [visibility] }));
assert.ok(filteredMarkup.includes('Vendor status'));
assert.ok(filteredMarkup.includes('Recent Inactive Vendor'));
assert.ok(filteredMarkup.includes('Inactive'));
assert.ok(!filteredMarkup.includes('Hidden Inactive Vendor'));
const unsafe = structuredClone(report); unsafe.rows[0].name = '<script>alert(1)</script>';
assert.ok(!renderToStaticMarkup(React.createElement(view.CapacityComplianceView, { reports: [unsafe] })).includes('<script>'));
console.log('Compliance loader/render checks passed: 1501 audit updates, zero counts, repeated saves, invalid-value exclusion, later-page failure, KPI/table rendering and escaped names.');

failed = false;
const monthly = compile('src/lib/vendor-capacity-month.ts', name => {
  if (name === './vendor-capacity-compliance-server') return loader;
  if (name === './vendor-capacity-compliance') return metrics;
  if (name.endsWith('/_shared')) return shared;
  if (name.endsWith('/month-boards')) return { loadCapacityEvents: async () => input.updates.map(u => ({ vendor: u.code.toLowerCase(), at: u.at, capacity: 0, machines: 10, karigar: 0 })) };
  if (name.endsWith('/analytics')) return { ANALYTICS_RULE_DEFAULTS: {} };
  if (name.endsWith('/approval')) return approval;
  if (name.endsWith('/business-logic')) return business;
  return {};
});
const data = await monthly.loadVendorCapacityMonth('2026-10-01', db);
assert.ok(data.compliance);
assert.equal(data.totals.compliancePct, metrics.complianceTotals(data.compliance.rows).score);
assert.ok(data.notes.some(n => n.includes('excludes the running week')));
const utilization = compile('src/lib/utilisation.ts', () => ({}));
const pdf = compile('src/lib/vendor-capacity-report.ts', name => {
  if (name === 'jspdf' || name === 'jspdf-autotable') return require(name);
  if (name.endsWith('/utilisation')) return utilization;
  return {};
});
const buffer = pdf.renderVendorCapacityReportPdf(data);
assert.equal(buffer.subarray(0, 5).toString(), '%PDF-');
assert.ok(buffer.length > 1000);
console.log('Monthly loader and PDF verified: completed-week KPI agrees with compliance engine; valid PDF rendered without publishing or notifications.');
