import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFileSync } from 'node:fs';
import ts from 'typescript';
function load(file, mocks = {}) {
  const module = { exports: {} };
  const code = ts.transpileModule(readFileSync(file, 'utf8'), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText;
  vm.runInNewContext(code, { module, exports: module.exports, require: (key) => mocks[key], URL });
  return module.exports;
}
const google = load('src/lib/commercial-google.ts');
const claims = { sub: 'v', amr: [{ method: 'oauth' }], app_metadata: { provider: 'email', providers: ['email', 'google'] } };
let checks = 0;
const check = (value) => { assert.ok(value); checks++; };
check(google.isCommercialGoogleSession(claims, 'v'));
for (const bad of [null, {}, { ...claims, sub: 'other' }, { ...claims, amr: [{ method: 'password' }] }, { ...claims, app_metadata: { providers: ['github'] } }, { sub: 'v', user_metadata: claims }]) check(!google.isCommercialGoogleSession(bad, 'v'));

let method = 'oauth', actor, error = null, lookupFails = false, signedOut = 0, rows = [];
const user = { id: 'v', email: 'vendor@example.com', app_metadata: { commercial_password_change_required: true }, identities: [{ provider: 'google' }] };
const session = { auth: {
  getUser: async () => ({ data: { user }, error: null }),
  getClaims: async () => ({ data: { claims: { ...claims, amr: [{ method }] } }, error: null }),
  exchangeCodeForSession: async () => ({ error }), signOut: async () => { signedOut++; },
} };
const access = load('src/lib/commercial-access.server.ts', {
  'server-only': {}, react: { cache: (fn) => fn }, './supabase/server': { createSessionClient: async () => session }, './supabase/page-all': {}, './views': {}, './commercial-google': google,
  './supabase/admin': { createAdminClient: () => ({ from: () => { const q = {}; for (const key of ['select', 'eq']) q[key] = () => q; q.maybeSingle = async () => ({ data: rows.shift(), error: null }); return q; } }) },
});
const vendorRows = () => [{ vendor_code: 'ABC' }, { vendor_name: 'ABC', is_active: true }];
rows = vendorRows(); check((await access.commercialActor()).passwordChangeRequired === false);
check(user.app_metadata.commercial_password_change_required === true);
method = 'password'; rows = vendorRows(); check(await access.commercialActor() === null);
const callback = load('src/app/commercial-requests/auth/callback/route.ts', {
  'next/server': { NextResponse: { redirect: (url) => new URL(url) } }, '@/lib/supabase/server': { createSessionClient: async () => session, hasSupabaseEnv: () => true },
  '@/lib/commercial-access.server': { commercialIdentity: async () => { if (lookupFails) throw new Error('Lookup failed'); return actor; } },
}).GET;
const req = (search = '?code=fixture') => ({ url: 'https://dashboard.test/commercial-requests/auth/callback' + search });
check((await callback(req(''))).pathname === '/commercial-requests/login');
check((await callback(req('?error=access_denied'))).pathname === '/commercial-requests/login');
error = {}; check((await callback(req())).pathname === '/commercial-requests/login'); error = null;
for (const denied of [null, { vendorCode: null, googleSession: true }, { vendorCode: 'ABC', googleSession: false }]) { actor = denied; const before = signedOut; check((await callback(req())).pathname === '/commercial-requests/login'); check(signedOut === before + 1); }
actor = { vendorCode: 'ABC', googleSession: true };
check((await callback(req('?code=fixture&next=https://evil.test'))).href === 'https://dashboard.test/commercial-requests');
lookupFails = true; check((await callback(req())).pathname === '/commercial-requests/login');
console.log(`Commercial Google authentication: ${checks} claims / identity / callback checks passed.`);
