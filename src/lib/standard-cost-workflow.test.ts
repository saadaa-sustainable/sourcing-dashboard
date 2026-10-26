import assert from 'node:assert/strict';
import test from 'node:test';
import { changedCostSections, copyCostReference, costEventChanges, parseCostSnapshot, validateCostSnapshot, type CostSnapshot } from './standard-cost-workflow';
const valid = (): CostSnapshot => ({ rates:{job_cost:1,fob_cost:2,efob_cost:3,total_po_avg_cost:2},fabric:{fabric_code:'FAB',fabric_uom:'mtr',lines:[{colour:'Blue',size:'M',consumption:1,fabric_cost:1,cm_cost:1,total_cost:2}],extras:[]},cmtp:[{category:'Labour',label:'Sewing',amount:1,position:0}],documents:{rfp_link:'https://example.com/rfp',cad_link:'https://example.com/cad',files:[{file_path:'NEW/id.pdf',file_name:'cad.pdf',file_size:200,doc_group:'single_piece',width:null,link_url:null,remark:null}]}});

test('optional expected/target rates round-trip and reject negative or malformed values',()=>{
  const s=valid();s.rates.proposed_cost=120;s.rates.target_job=10;s.rates.target_fob=null;
  assert.deepEqual(parseCostSnapshot(s),s);
  assert.deepEqual(validateCostSnapshot(s,['rates'],false),[]);
  s.rates.target_efob=-1;
  assert.match(validateCostSnapshot(s,['rates'],false).join(' '),/target efob/);
  assert.throws(()=>parseCostSnapshot({...s,rates:{...s.rates,proposed_cost:'invalid'}}));
});
test('new submissions require every section, finite numeric fields, CMTP, CAD reference and an uploaded PDF',()=>{
  const s=valid();assert.deepEqual(validateCostSnapshot(s,[],true),[]);
  s.rates.job_cost=null;s.fabric.lines[0].consumption=NaN;s.cmtp=[];s.documents.cad_link='';s.documents.files=[];
  const errors=validateCostSnapshot(s,[],true).join(' ');
  for(const pattern of [/job cost/,/Every size line/,/CMTP/,/CAD reference link/,/CAD PDF/]) assert.match(errors,pattern);
});
test('copy includes complete costing but clears CAD files and CAD links without mutating source',()=>{
  const s=valid(),copy=copyCostReference(s);
  assert.deepEqual(copy.rates,s.rates);assert.deepEqual(copy.fabric,s.fabric);assert.deepEqual(copy.cmtp,s.cmtp);
  assert.equal(copy.documents.rfp_link,s.documents.rfp_link);assert.deepEqual(copy.documents.files,[]);assert.equal(copy.documents.cad_link,'');assert.equal(s.documents.files.length,1);
});
test('amendment validates selected sections and never requires an unchanged CAD re-upload',()=>{
  const s=valid();s.documents.files=[];s.documents.rfp_link='';s.fabric.lines=[];
  assert.deepEqual(validateCostSnapshot(s,['cmtp'],false),[]);
  assert.deepEqual(validateCostSnapshot(s,['rates'],false),[]);
});
test('diff detects row removal and a single section change',()=>{
  const s=valid(),n=structuredClone(s);n.cmtp=[];
  assert.deepEqual(changedCostSections(s,n),['cmtp']);
});
test('zero is valid; blank, negative and infinite rates are rejected',()=>{
  const s=valid();s.rates.job_cost=0;assert.deepEqual(validateCostSnapshot(s,['rates'],false),[]);
  for(const n of [null,-1,Infinity]) {s.rates.job_cost=n;assert.ok(validateCostSnapshot(s,['rates'],false).length);}
});
test('duplicate sizes, repeated main fabric and incomplete CAD widths are rejected',()=>{
  const s=valid();s.fabric.lines.push({...s.fabric.lines[0]});
  s.fabric.extras.push({fabric_code:'FAB',size:'M',position:1,uom:'mtr',consumption:1,fabric_cost:1});
  s.documents.files[0].doc_group='full_layer';
  const errors=validateCostSnapshot(s,[],true).join(' ');
  assert.match(errors,/Duplicate/);assert.match(errors,/repeat the main/);assert.match(errors,/width/);
});
test('draft parser rejects malformed sections and unsafe links without inventing section changes',()=>{
  const source=valid();
  assert.deepEqual(changedCostSections(source,parseCostSnapshot(source)),[]);
  assert.throws(()=>parseCostSnapshot({...source,cmtp:'broken'}));
  assert.throws(()=>parseCostSnapshot({...source,documents:{...source.documents,cad_link:'javascript:alert(1)'}}));
  assert.throws(()=>parseCostSnapshot({...source,rates:{...source.rates,job_cost:Infinity}}));
});
test('approval changelog shows applied values against the baseline rather than an unchanged pending payload',()=>{
  const base=valid(),payload=valid();payload.rates.job_cost=8;
  const changes=costEventChanges({id:1,revision_id:1,product_code:'NEW',event:'approve',actor:'admin',reason:'Rate increased',sections:['rates'],before_data:{base,payload,status:'pending'},after_data:{payload,status:'approved'},created_at:'2026-10-25'});
  assert.ok(changes.some(c=>c.field.endsWith('job cost')&&c.before==='1'&&c.after==='8'));
  assert.ok(changes.some(c=>c.field==='Approval status'&&c.after==='approved'));
});
