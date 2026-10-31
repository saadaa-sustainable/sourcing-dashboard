import assert from 'node:assert/strict';
import vm from 'node:vm';
import ts from 'typescript';
import { readFileSync } from 'node:fs';
const compile = (file, require) => {
  const exports = {};
  vm.runInNewContext(ts.transpileModule(readFileSync(file, 'utf8'), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText, { exports, require, FormData, Date });
  return exports;
};
const validation = compile('src/lib/po-cad-required.server.ts', () => ({}));
const rework = compile('src/lib/po-rework.ts', () => ({}));
let docs = [], readError = null, writes = 0;
let po = { id: 1, status: 'draft', rework_sections: null, po_type: 'job_work' };
const db = { from(table) {
  const filters = [];
  const q = {
    select(columns, options) { if (table === 'sd_po_cad_document') assert.equal(JSON.stringify(options), JSON.stringify({ count: 'exact', head: true })); return q; },
    eq(key, value) { filters.push(row => row[key] === value); return q; },
    is(key) { filters.push(row => row[key] == null); return q; },
    not(key) { filters.push(row => row[key] != null); return q; },
    maybeSingle: async () => ({ data: po }),
    update() { writes++; throw Error('Unexpected write'); },
    insert() { writes++; throw Error('Unexpected write'); },
    then(resolve, reject) { return Promise.resolve({ count: docs.filter(row => filters.every(test => test(row))).length, error: readError }).then(resolve, reject); },
  }; return q;
} };
assert.match(await validation.requiredPoCadError(db, 0), /Save the Order/);
assert.match(await validation.requiredPoCadError(db, 1), /Upload at least one/);
docs = [{ po_id: 2, uploaded_at: 'saved', removed_at: null }, { po_id: 1, uploaded_at: null, removed_at: null }, { po_id: 1, uploaded_at: 'saved', removed_at: 'removed' }];
assert.match(await validation.requiredPoCadError(db, 1), /Upload at least one/, 'Other PO, pending tickets and removed files excluded');
docs.push({ po_id: 1, uploaded_at: 'saved', removed_at: null });
assert.equal(await validation.requiredPoCadError(db, 1), null);
readError = { message: 'unavailable' };
assert.match(await validation.requiredPoCadError(db, 1), /Could not verify/, 'Read failures block the action');
readError = null; docs = [];
const actions = compile('src/lib/forms/actions-modules/po-approval.ts', name => {
  if (name === '@/lib/po-cad-required.server') return validation;
  if (name === '@/lib/po-rework') return rework;
  if (name === '../queries') return { currentUser: async () => ({ role: 'team' }) };
  if (name === '../approval') return { canEdit: () => true, canSubmit: () => true };
  if (name === '@/lib/business-logic') return { istToday: () => new Date('2026-10-30'), tnaBaseFor: () => ({ date: '2026-10-30' }), tnaScheduleFrom: () => ({}) };
  if (name === '@/lib/po-tna-validation') return { invalidPoTnaFields: () => ['Stop after CAD gate'] };
  if (name === './_shared') return { supa: async () => db, fail: error => ({ ok: false, error }), textOrNull: v => v || null, numOrNull: v => v == null ? null : Number(v) };
  return {};
});
const data = new FormData(); data.set('id', '1'); data.set('saved_section', 'cost'); data.set('rate', '100');
assert.match((await actions.savePoApproval(data)).error, /Upload at least one/, 'Cost save checks attachments on server');
assert.match((await actions.submitPoApproval(data)).error, /Upload at least one/, 'Direct submission cannot skip Cost');
po = { ...po, status: 'rework', rework_sections: ['cost'] };
assert.match((await actions.submitPoApproval(data)).error, /Upload at least one/, 'Cost rework requires CAD');
po = { ...po, rework_sections: ['tna'] };
assert.match((await actions.submitPoApproval(data)).error, /Stop after CAD gate/, 'Locked Cost preserved for TNA-only rework');
po = { ...po, rework_sections: ['sku'] };
assert.match((await actions.submitPoApproval(data)).error, /Stop after CAD gate/, 'Locked Cost preserved for SKU-only rework');
po = { ...po, status: 'draft', rework_sections: null };
docs = [{ po_id: 1, uploaded_at: 'saved', removed_at: null }];
assert.match((await actions.submitPoApproval(data)).error, /Stop after CAD gate/, 'Completed upload allows remaining submission validation');
assert.equal(writes, 0);
console.log('Mandatory PO CAD checks passed: active completed upload, fail-closed reads, Cost save, direct submit and scoped rework.');
