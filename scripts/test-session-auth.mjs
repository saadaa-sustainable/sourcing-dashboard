import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';
import ts from 'typescript';

// Isolated auth/cookie contract tests: no Supabase requests or real credentials.
const jar = new Map();
const writes = [];
const calls = [];
const admin = { kind: 'admin-data-client' };
const sandbox = vm.createContext({
 process: { env: {
  NEXT_PUBLIC_SUPABASE_URL: 'https://example.supabase.co',
  NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY: 'test-publishable-key',
  LOCAL_AUTH_BYPASS: 'true',
 } },
 FormData, URL,
});
function synthetic(values) {
 return new vm.SyntheticModule(Object.keys(values),function() {
  for (const [key,value] of Object.entries(values)) this.setExport(key,value);
 },{context:sandbox});
}
const redirect = location => { throw Object.assign(new Error('redirect'),{location}); };
const modules = new Map();
modules.set('next/headers',synthetic({cookies:async()=>({
 getAll:()=>[...jar].map(([name,value])=>({name,value})),
 set:(name,value,options)=>{writes.push({name,value,options}); if(options?.maxAge===0) jar.delete(name); else jar.set(name,value);},
})}));
modules.set('./admin',synthetic({createAdminClient:()=>admin}));
modules.set('next/navigation',synthetic({redirect}));
modules.set('next/server',synthetic({NextResponse:{redirect:location=>({location})}}));
modules.set('@supabase/ssr',synthetic({createServerClient:(url,key,options)=>{
 assert.equal(key,'test-publishable-key');
 return {kind:'session-client',auth:{
  signInWithPassword:async credentials=>{
   calls.push('password');
   if(credentials.password==='wrong') return {error:{message:'Invalid login credentials'}};
   options.cookies.setAll([{name:'session',value:'signed-user',options:{httpOnly:true}}]);
   return {error:null};
  },
  exchangeCodeForSession:async code=>{
   calls.push('oauth');
   assert.equal(code,'valid-code');
   assert.ok(options.cookies.getAll().some(c=>c.name==='code-verifier'&&c.value==='verifier'));
   options.cookies.setAll([{name:'session',value:'signed-user',options:{httpOnly:true}}]);
   return {data:{user:{email:'owner@saadaa.in'}},error:null};
  },
  getUser:async()=>({data:{user:options.cookies.getAll().some(c=>c.name==='session')?{email:'owner@saadaa.in'}:null}}),
  signOut:async()=>{
   calls.push('logout');
   options.cookies.setAll([{name:'session',value:'',options:{maxAge:0}}]);
   return {error:null};
  },
 }};
}}));
async function load(path,name) {
 const source=await readFile(new URL('../'+path,import.meta.url),'utf8');
 const output=ts.transpileModule(source,{compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.ESNext}}).outputText;
 const module=new vm.SourceTextModule(output,{context:sandbox,identifier:name});
 modules.set(name,module);
 await module.link(specifier=>{
  const dependency=modules.get(specifier);
  if(!dependency) throw new Error('Unexpected dependency: '+specifier);
  return dependency;
 });
 await module.evaluate();
 return module.namespace;
}
const clients=await load('src/lib/supabase/server.ts','@/lib/supabase/server');
const login=await load('src/app/login/actions.ts','login');
const callback=await load('src/app/auth/callback/route.ts','callback');
const logout=await load('src/lib/auth-actions.ts','logout');
let checks=0;
const ok=value=>{assert.ok(value);checks++;};
ok((await clients.createClient())===admin); // preserve existing bypass for data only
ok((await clients.createSessionClient()).kind==='session-client');
const form=new FormData(); form.set('email','owner@saadaa.in'); form.set('password','valid');
await assert.rejects(()=>login.login(form),error=>error.location==='/my-dashboard'); checks++;
ok(jar.get('session')==='signed-user');
ok((await (await clients.createSessionClient()).auth.getUser()).data.user.email==='owner@saadaa.in');
await assert.rejects(()=>logout.signOut(),error=>error.location==='/login'); checks++;
ok(!jar.has('session'));
jar.set('code-verifier','verifier');
ok((await callback.GET(new Request('http://localhost:3000/auth/callback?code=valid-code'))).location==='http://localhost:3000/my-dashboard');
ok(jar.get('session')==='signed-user');
const before=calls.length;
ok((await callback.GET(new Request('http://localhost:3000/auth/callback'))).location==='http://localhost:3000/login');
ok(calls.length===before);
form.set('password','wrong');
await assert.rejects(()=>login.login(form),error=>error.location==='/login?error=Invalid%20login%20credentials'); checks++;
form.set('email','outsider@example.com');
const beforeOutside=calls.length;
await assert.rejects(()=>login.login(form),error=>error.location.startsWith('/login?error=')); checks++;
ok(calls.length===beforeOutside);
sandbox.process.env.LOCAL_AUTH_BYPASS='false';
ok((await clients.createClient()).kind==='session-client');
ok(writes.some(c=>c.name==='session'&&c.options?.maxAge===0));
console.log('PASS: '+checks+' session persistence, OAuth verifier, sign-out, domain and local-bypass assertions.');
