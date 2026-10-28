import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFileSync } from 'node:fs';
import ts from 'typescript';
let user = { id: 'v', email: 'vendor@example.com', app_metadata: { commercial_password_change_required: true }, user_metadata: { commercial_password_change_required: false } };
let identity, verifyError = null, passwordError = null, flagError = null, calls = [];
let rows = [];
const session = { auth: {
  getUser: async () => ({ data: { user }, error: null }),
  signInWithPassword: async () => { calls.push('verify'); return { error: verifyError }; },
  updateUser: async () => { calls.push('password'); return { error: passwordError }; },
  signOut: async () => { calls.push('signout'); return { error: null }; },
} };
const admin = {
  from: () => { const chain = {}; for (const key of ['select', 'eq']) chain[key] = () => chain; chain.maybeSingle = async () => ({ data: rows.shift(), error: null }); return chain; },
  auth: { admin: { updateUserById: async (id, patch) => { calls.push(['flag', id, patch]); return { error: flagError }; } } },
};
const redirect = (url) => { const error = new Error('redirect'); error.url = url; throw error; };
function load(file, mocks) {
  const module = { exports: {} };
  const code = ts.transpileModule(readFileSync(file, 'utf8'), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText;
  vm.runInNewContext(code, { module, exports: module.exports, require: (key) => mocks[key], FormData });
  return module.exports;
}
const access = load('src/lib/commercial-access.server.ts', {
  'server-only': {}, react: { cache: (fn) => fn }, './supabase/server': { createSessionClient: async () => session }, './supabase/admin': { createAdminClient: () => admin }, './supabase/page-all': {}, './views': {},
});
const mapping = { vendor_code: 'ABC' }, vendor = { vendor_name: 'ABC Vendor', is_active: true };
rows = [mapping, vendor];
assert.equal((await access.commercialIdentity()).passwordChangeRequired, true);
rows = [mapping, vendor]; assert.equal(await access.commercialActor(), null);
user.app_metadata.commercial_password_change_required = false;
user.user_metadata.commercial_password_change_required = true;
rows = [mapping, vendor]; assert.equal((await access.commercialActor()).vendorCode, 'ABC');
const actions = load('src/app/commercial-requests/session-actions.ts', {
  'next/navigation': { redirect }, '@/lib/supabase/server': { createSessionClient: async () => session, hasSupabaseEnv: () => true },
  '@/lib/commercial-access.server': { commercialIdentity: async () => identity }, '@/lib/supabase/admin': { createAdminClient: () => admin },
});
const form = (extra = {}) => { const fd = new FormData(); for (const [key, value] of Object.entries({ current_password: 'Temporary-password-123', new_password: 'New-private-password-123', confirm_password: 'New-private-password-123', ...extra })) fd.set(key, value); return fd; };
let count = 3;
identity = null; assert.equal((await actions.changeVendorTemporaryPassword(form())).ok, false); count++;
identity = { uid: 'v', email: user.email, vendorCode: 'ABC', passwordChangeRequired: true };
for (const extra of [{ current_password: '' }, { new_password: 'short' }, { confirm_password: 'mismatch' }, { new_password: 'Temporary-password-123', confirm_password: 'Temporary-password-123' }]) {
  calls = []; assert.equal((await actions.changeVendorTemporaryPassword(form(extra))).ok, false); assert.equal(calls.length, 0); count++;
}
verifyError = {}; calls = []; await actions.changeVendorTemporaryPassword(form()); assert.deepEqual(calls, ['verify']); count++;
verifyError = null; passwordError = {}; calls = []; await actions.changeVendorTemporaryPassword(form()); assert.deepEqual(calls, ['verify', 'password']); count++;
passwordError = null; flagError = {}; calls = []; assert.match((await actions.changeVendorTemporaryPassword(form())).error, /password changed/); assert.equal(calls.includes('signout'), false); count++;
flagError = null; calls = [];
await assert.rejects(() => actions.changeVendorTemporaryPassword(form()), (error) => error.url?.startsWith('/commercial-requests/login?message='));
assert.equal(calls[0], 'verify'); assert.equal(calls[1], 'password'); assert.equal(calls[2][2].app_metadata.commercial_password_change_required, false); assert.equal(calls[3], 'signout'); count++;
await assert.rejects(() => actions.vendorCommercialLogin(form()), (error) => error.url === '/commercial-requests/change-password'); count++;
console.log(`Commercial temporary passwords: ${count} identity / password-flow checks passed.`);
