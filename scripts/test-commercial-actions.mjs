import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import ts from 'typescript';
let actor, responses = [], calls = [];
const query = (table) => {
  const chain = { then(resolve, reject) { return Promise.resolve(responses.shift()).then(resolve, reject); } };
  for (const method of ['select', 'insert', 'update', 'eq', 'neq', 'upsert']) chain[method] = (...args) => { calls.push({ table, method, args }); return chain; };
  chain.maybeSingle = async () => responses.shift();
  return chain;
};
const db = { from: query };
let authPages = [], createError = null, cleanupError = null;
db.auth = { admin: {
  listUsers: async (options) => { calls.push({ method: 'listUsers', args: [options] }); return { data: { users: authPages[options.page - 1] ?? [] }, error: null }; },
  createUser: async (input) => { calls.push({ method: 'createUser', args: [input] }); return { data: { user: createError ? null : { id: 'new-user', email: input.email } }, error: createError }; },
  deleteUser: async (id) => { calls.push({ method: 'deleteUser', args: [id] }); return { error: cleanupError }; },
} };
const cache = new Map();
function load(path) {
  if (cache.has(path)) return cache.get(path);
  const module = { exports: {} };
  const require = (name) => {
    if (name === 'node:crypto') return { randomUUID: () => '00000000-0000-4000-8000-000000000001' };
    if (name === 'next/cache') return { revalidatePath() {} };
    if (name === '@/lib/supabase/admin') return { createAdminClient: () => db };
    if (name === '@/lib/commercial-access.server') return { commercialActor: async () => actor, commercialPos: async () => [{ po_ref_num: 'PO-1', vendor_code: 'ABC' }] };
    if (name === './_shared') return { fail: (error) => ({ ok: false, error }), done: (message) => ({ ok: true, message }) };
    if (name === '../approval') return { statusOnSubmit: () => 'pending_l2' };
    const base = path.slice(0, path.lastIndexOf('/'));
    const resolved = new URL(`${name}.ts`, `file:///${base}/`).pathname.slice(1);
    return load(resolved);
  };
  const code = ts.transpileModule(readFileSync(path, 'utf8'), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText;
  vm.runInNewContext(code, { require, exports: module.exports, module, FormData, console, Date, Set }, { filename: path });
  cache.set(path, module.exports);
  return module.exports;
}
const actions = load('src/lib/forms/actions-modules/vendor-commercial.ts');
const vendor = { email: 'vendor@example.com', uid: 'v', role: 'viewer', vendorCode: 'ABC', vendorName: 'ABC Vendor' };
const admin = { email: 'admin@saadaa.in', uid: 'a', role: 'admin', vendorCode: null };
const row = { id: 1, revision: 2, status: 'pending_l2', requested_by: vendor.email, vendor_code: 'ABC', request_type: 'credit_note', details: {}, credit_amount: 100, approved_amount: 100, attachments: [] };
const fd = (extra = {}) => { const f = new FormData(); for (const [k, v] of Object.entries({ id: '1', revision: '2', decision: 'approve', approved_amount: '100', ...extra })) f.set(k, v); return f; };
let checks = 0;
async function run(fn, f, expected, replies = []) {
  responses = [...replies]; calls = [];
  const result = await fn(f);
  assert.equal(result.ok, expected, result.error); checks++;
  return result;
}
actor = null;
await run(actions.createVendorCommercialRequest, fd(), false);
await run(actions.decideCommercialRequest, fd(), false);
actor = { ...admin, role: 'viewer' };
await run(actions.createVendorCommercialRequest, fd(), false);
actor = vendor;
assert.equal((await actions.startCommercialUpload('OTHER', 'proof.pdf', 100)).ok, false); checks++;
responses = [{ data: { ...row, vendor_code: 'OTHER' } }];
assert.equal('error' in await actions.signCommercialFile(1, 'any'), true); checks++;
await run(actions.updateVendorCommercialRequest, fd(), false, [{ data: { ...row, requested_by: 'other@example.com' } }]);
await run(actions.updateVendorCommercialRequest, fd(), false, [{ data: { ...row, status: 'approved' } }]);
await run(actions.decideCommercialRequest, fd(), false);
actor = admin;
await run(actions.decideCommercialRequest, fd({ revision: '1' }), false, [{ data: row }]);
await run(actions.decideCommercialRequest, fd(), false, [{ data: { ...row, requested_by: admin.email } }]);
await run(actions.decideCommercialRequest, fd({ decision: 'rework', notes: '' }), false);
await run(actions.decideCommercialRequest, fd({ approved_amount: '101' }), false, [{ data: row }]);
await run(actions.decideCommercialRequest, fd({ decision: 'reopen', notes: 'Amend' }), false, [{ data: { ...row, status: 'approved', processing_status: 'processed' } }]);
await run(actions.decideCommercialRequest, fd({ decision: 'process', notes: 'Processed', processed_amount: '101', processed_reference: 'CN-1' }), false, [{ data: { ...row, status: 'approved' } }]);
await run(actions.decideCommercialRequest, fd(), true, [{ data: row }, { data: { id: 1 } }]);
assert.ok(calls.some((c) => c.method === 'eq' && c.args[0] === 'revision' && c.args[1] === 2)); checks++;
assert.ok(calls.some((c) => c.method === 'update' && c.args[0].approved_by === admin.email)); checks++;
await run(actions.decideCommercialRequest, fd({ approved_amount: '' }), true, [{ data: { ...row, request_type: 'cash_discount', details: { cd_percent: '2' }, invoice_amount: 10000 } }, { data: { id: 1 } }]);
assert.ok(calls.some((c) => c.method === 'update' && c.args[0].approved_amount === null && c.args[0].status === 'approved')); checks++;
await run(actions.decideCommercialRequest, fd({ approved_amount: '' }), true, [{ data: { ...row, request_type: 'grn_delay_waiver', details: { delivery_date: '2026-10-01', grn_date: '2026-10-09', grn_delay_days: '999' } } }, { data: { id: 1 } }]);
assert.ok(calls.some((c) => c.method === 'update' && c.args[0].approved_amount === null && c.args[0].details.grn_delay_days === '8')); checks++;
await run(actions.decideCommercialRequest, fd({ approved_amount: '' }), true, [{ data: { ...row, request_type: 'surplus_fabric_consumption', details: { initial_consumption: '100', revised_consumption: '102', increased_consumption: '999' } } }, { data: { id: 1 } }]);
assert.ok(calls.some((c) => c.method === 'update' && c.args[0].approved_amount === null && c.args[0].details.increased_consumption === '2')); checks++;
await run(actions.decideCommercialRequest, fd(), false, [{ data: { ...row, request_type: 'surplus_fabric_consumption', details: { initial_consumption: '100', revised_consumption: '101' } } }]);
const hold = { ...row, request_type: 'hold_waiver', details: { hold_start: '2026-10-28', hold_end: '2026-10-31', requested_amount: '9999' } };
await run(actions.decideCommercialRequest, fd({ approved_amount: '9999' }), true, [{ data: hold }, { data: { id: 1 } }]);
assert.ok(calls.some((c) => c.method === 'update' && c.args[0].approved_amount === null && c.args[0].details.approved_waiver_days === '3')); checks++;
await run(actions.decideCommercialRequest, fd(), false, [{ data: { ...hold, details: {} } }]);
await run(actions.decideCommercialRequest, fd({ decision: 'process', notes: 'Waiver applied', processed_amount: '', processed_reference: 'W-1' }), true, [{ data: { ...hold, status: 'approved', details: { ...hold.details, approved_waiver_days: '3' } } }, { data: { id: 1 } }]);
assert.ok(calls.some((c) => c.method === 'update' && c.args[0].processed_amount === null && c.args[0].processing_status === 'processed')); checks++;
await run(actions.decideCommercialRequest, fd({ decision: 'process', notes: 'Waiver applied', processed_reference: 'W-1' }), false, [{ data: { ...hold, status: 'approved' } }]);
await run(actions.decideCommercialRequest, fd({ decision: 'reopen', notes: 'Update dates' }), true, [{ data: { ...hold, status: 'approved', details: { ...hold.details, approved_waiver_days: '3' } } }, { data: { id: 1 } }]);
assert.ok(calls.some((c) => c.method === 'update' && !('approved_waiver_days' in c.args[0].details))); checks++;
await run(actions.decideCommercialRequest, fd({ decision: 'rework', notes: 'Correct the amount' }), true, [{ data: row }, { data: { id: 1 } }]);
assert.ok(calls.some((c) => c.method === 'update' && c.args[0].status === 'rework')); checks++;
await run(actions.decideCommercialRequest, fd({ decision: 'process', notes: 'Credit issued', processed_amount: '80', processed_reference: 'CN-1' }), true, [{ data: { ...row, status: 'approved' } }, { data: { id: 1 } }]);
assert.ok(calls.some((c) => c.method === 'update' && c.args[0].processing_status === 'processed')); checks++;
actor = vendor;
await run(actions.createVendorCommercialRequest, fd({ request_type: 'credit_note' }), false);
const form = fd({ business_type: 'fabric', vendor_code: 'SPOOF', vendor_name: 'Spoof', po_numbers: 'PO-1', request_type: 'hold_waiver', intent: 'draft', submission_key: '00000000-0000-4000-8000-000000000001', details: '{}' });
await run(actions.createVendorCommercialRequest, form, true, [{ data: { vendor_name: 'Canonical name', is_active: true } }, { error: null }]);
assert.equal(form.get('vendor_code'), 'ABC'); checks++;
assert.ok(calls.some((c) => c.method === 'insert' && c.args[0].vendor_name === 'Canonical name' && c.args[0].requested_by === vendor.email)); checks++;
form.set('po_numbers', 'OTHER-PO');
await run(actions.createVendorCommercialRequest, form, false, [{ data: { vendor_name: 'Canonical name', is_active: true } }]);
form.set('po_numbers', 'PO-1'); form.set('intent', 'submit'); form.set('remarks', 'Revised request');
form.set('hold_qty', '100'); form.set('hold_days', '5'); form.set('ready_date', '2026-10-27');
form.set('details', JSON.stringify({ quantity_unit: 'metres', hold_start: '2026-10-27', hold_end: '2026-10-30', hold_requested_by: 'Sourcing team' }));
const holdProof = [{ path: 'ABC/00000000-0000-4000-8000-000000000001.pdf', name: 'proof.pdf', size: 100 }];
form.set('attachments', JSON.stringify(holdProof));
await run(actions.updateVendorCommercialRequest, form, true, [{ data: { ...row, status: 'rejected', attachments: holdProof } }, { data: { vendor_name: 'Canonical name', is_active: true } }, { data: { id: 1 } }]);
assert.ok(calls.some((c) => c.method === 'update' && c.args[0].status === 'pending_l2')); checks++;
const accountForm = fd({ email: 'newvendor@example.com', full_name: 'Vendor Contact', password: 'Fixture-password-123', vendor_code: 'ABC', is_active: 'true' });
actor = vendor;
await run(actions.createCommercialVendorLogin, accountForm, false);
actor = admin;
await run(actions.createCommercialVendorLogin, fd({ email: 'staff@saadaa.in' }), false);
await run(actions.createCommercialVendorLogin, fd({ email: 'vendor@example.com', password: 'short' }), false);
authPages = [];
await run(actions.createCommercialVendorLogin, accountForm, true, [{ data: { is_active: true } }, { error: null }]);
assert.ok(calls.some((c) => c.method === 'insert' && c.args[0].user_id === 'new-user' && c.args[0].is_active === true)); checks++;
assert.ok(calls.some((c) => c.method === 'createUser' && c.args[0].email_confirm === true)); checks++;
assert.ok(calls.some((c) => c.method === 'createUser' && c.args[0].app_metadata.commercial_password_change_required === true)); checks++;
authPages = [[{ id: 'existing-user', email: 'newvendor@example.com' }]];
await run(actions.createCommercialVendorLogin, accountForm, false, [{ data: { is_active: true } }]);
assert.ok(!calls.some((c) => c.method === 'createUser' || c.method === 'deleteUser')); checks++;
authPages = [];
await run(actions.createCommercialVendorLogin, accountForm, false, [{ data: { is_active: true } }, { error: { message: 'Link failed' } }]);
assert.ok(calls.some((c) => c.method === 'deleteUser' && c.args[0] === 'new-user')); checks++;
authPages = [Array.from({ length: 100 }, (_, i) => ({ id: String(i), email: `other${i}@example.com` })), [{ id: 'existing-user', email: 'newvendor@example.com' }]];
await run(actions.linkCommercialVendor, accountForm, true, [{ data: { is_active: true } }, { error: null }]);
assert.ok(calls.some((c) => c.method === 'listUsers' && c.args[0].page === 2)); checks++;
assert.ok(calls.some((c) => c.method === 'upsert' && c.args[0].user_id === 'existing-user')); checks++;
assert.ok(!calls.some((c) => c.method === 'createUser' || c.method === 'deleteUser')); checks++;
console.log(`Commercial server actions: ${checks} authorization / revision / provisioning checks passed.`);

// Exercise the actual session proxy with signed-claim fixtures, including POSTs.
let proxyEmail = vendor.email;
const cookieJar = () => ({ getAll: () => [], set() {} });
const response = (kind, target, status) => ({ kind, target, status, cookies: cookieJar() });
const proxyModule = { exports: {} };
const proxyCode = ts.transpileModule(readFileSync('src/lib/supabase/proxy.ts', 'utf8'), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText;
vm.runInNewContext(proxyCode, {
  exports: proxyModule.exports, module: proxyModule, URL,
  process: { env: { NEXT_PUBLIC_SUPABASE_URL: 'https://example.supabase.co', NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY: 'fixture' } },
  require: (name) => name === '@supabase/ssr' ? { createServerClient: () => ({ auth: { getClaims: async () => ({ data: { claims: { email: proxyEmail } } }) } }) } : { NextResponse: { next: () => response('next'), redirect: (url) => response('redirect', url.pathname), json: (_, { status }) => response('json', null, status) } },
});
const proxy = proxyModule.exports.updateSession;
const requestFor = (path, method = 'GET') => ({ method, url: 'https://dashboard.test' + path, nextUrl: { pathname: path }, cookies: cookieJar() });
assert.equal((await proxy(requestFor('/vendor-commercial'))).kind, 'redirect');
assert.equal((await proxy(requestFor('/api/approvals/list', 'POST'))).status, 403);
assert.equal((await proxy(requestFor('/commercial-requests'))).kind, 'next');
assert.equal((await proxy(requestFor('/commercial-requests/login', 'POST'))).kind, 'next');
assert.equal((await proxy(requestFor('/commercial-requests-evil'))).kind, 'redirect');
proxyEmail = 'admin@saadaa.in';
assert.equal((await proxy(requestFor('/vendor-commercial'))).kind, 'next');
console.log('Commercial session proxy: 6 isolation checks passed.');
