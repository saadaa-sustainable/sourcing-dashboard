import { readFile } from 'node:fs/promises';
// Reuse the isolated fixture and all section guard assertions before checking the upgrade.
const base = await readFile(new URL('./test-po-rework-sections.mjs',import.meta.url),'utf8');
const upgraded = base.replace("console.log(checks+' database assertions passed');",`await db.exec("alter table sd_po_approval add column reworked_at timestamptz");
await db.exec(await readFile(new URL('../supabase/migrations/20261023173924_po_tna_rework_saved_state.sql',import.meta.url),'utf8'));
await denied("update sd_po_approval set status='submitted' where id=1", /Save the TNA/);
await ok("update sd_po_approval set tna_rework_saved_at=now() where id=1");
await ok("update sd_po_approval set status='submitted' where id=1");
await ok("update sd_po_approval set status='rework',rework_sections=array['tna'],reworked_at=now() where id=1");
assert.equal((await db.query('select tna_rework_saved_at from sd_po_approval where id=1')).rows[0].tna_rework_saved_at,null);checks++;
await denied("update sd_po_approval set status='submitted' where id=1", /Save the TNA/);
await ok("update sd_po_approval set tna_days_first_delivery=12,tna_rework_saved_at=now() where id=1");
await ok("update sd_po_approval set status='submitted' where id=1");
console.log(checks+' database assertions passed including TNA saved-state upgrade');`);
// Evaluate as a temporary module beside this file so relative fixture paths remain intact.
const {writeFile,unlink} = await import('node:fs/promises');
const temp = new URL('./.test-po-tna-rework-runtime.mjs',import.meta.url);
try { await writeFile(temp,upgraded); await import(temp.href); } finally { await unlink(temp); }
