import assert from 'node:assert/strict';

// Running Next dev server; no login, cookies or business records are used.
const origin=new URL(process.argv[2]??'http://172.31.208.1:3000').origin;
const page=await fetch(origin+'/login');
assert.equal(page.status,200,'Login page did not load');
const html=await page.text();
const scripts=[...html.matchAll(/<script[^>]+src="([^"]+)"/g)].map(match=>new URL(match[1].replaceAll('&amp;','&'),origin));
assert.ok(scripts.length>0,'No Next.js scripts found');
let checks=1;
for(const url of scripts){
 assert.equal(url.origin,origin,'Unexpected external script');
 const response=await fetch(url,{headers:{Origin:origin,Referer:origin+'/login'}});
 assert.equal(response.status,200,'Development script blocked for the dashboard host: '+url.pathname);
 checks++;
}
const denied=await fetch(scripts[0],{headers:{Origin:'http://untrusted.example',Referer:'http://untrusted.example/'}});
assert.equal(denied.status,403,'Untrusted development origins must remain blocked');checks++;
console.log('PASS: '+checks+' live development-origin checks on '+origin+'; own-host scripts load and untrusted origins remain blocked.');
