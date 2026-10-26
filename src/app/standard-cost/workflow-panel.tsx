'use client';

import { useId, useState, useTransition, type ReactNode } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { createClient } from '@/lib/supabase/client';
import { COST_DOC_BUCKET } from '@/lib/cost-documents';
import { SECTION_LABEL, copyCostReference, costEventChanges, type CostSnapshot, type CostRevision, type CostSection, type CostWorkflowEvent } from '@/lib/standard-cost-workflow';
import type { MaterialCostWorkflowEvent } from '@/lib/standard-cost-workflow.server';
import { loadReferenceCost, openWorkflowCad, saveCostWorkflow, workflowCadUpload } from './workflow-actions';
import './workflow.css';
import { Combobox } from '@/components/forms/combobox';
import { AmendmentCmtp } from './amendment-cmtp';
import { AmendmentFabric, type FabricRates } from './amendment-fabric';

const numeric = (value: string) => value.trim() === '' ? null : Number(value);
const date = (value: string) => new Date(value).toLocaleString('en-IN', { timeZone: 'Asia/Kolkata' });
const AMENDMENT_TABS = [{ key:'cmtp', label:'CMTP' }, { key:'fabric', label:'Fabric Cost' }, { key:'documents', label:'Files and Links' }, { key:'rates', label:'Final Cost' }, { key:'history', label:'Rate History' }, { key:'trims', label:'Trim History' }] as const;
type AmendmentTab = typeof AMENDMENT_TABS[number]['key'];

function normalizeCadReference(snapshot: CostSnapshot | null): CostSnapshot | null {
  if (!snapshot?.documents.cad_link || snapshot.documents.files.some(file => file.link_url === snapshot.documents.cad_link)) return snapshot;
  return { ...snapshot, documents: { ...snapshot.documents, cad_link: '', files: [...snapshot.documents.files, { file_path:null, file_name:null, file_size:null, doc_group:'single_piece', width:null, link_url:snapshot.documents.cad_link, remark:null }] } };
}

const CAD_GROUPS = [
  { key: 'single_piece', label: 'Single piece' },
  { key: 'full_layer', label: 'Full layer · single size per width' },
  { key: 'standard_ratio', label: 'Standard ratio' },
  { key: 'ratio_1_1', label: '1:1 size ratio' },
];

function FinalCostTable({ payload, marginPct }: { payload: CostSnapshot; marginPct: number }) {
  const cmtp = payload.cmtp.reduce((sum,row) => sum + (row.amount ?? 0),0);
  const format = (value: number | null) => value == null ? '—' : value.toLocaleString('en-IN', { maximumFractionDigits: 2 });
  const columns = [
    ['Size','Product size; colour is shown when multiple colours are present.'],
    ['Fabric','Fabric cost for this size from the Fabric Cost section.'],
    ['CMTP','Total of all CMTP cost heads.'],
    ['Garment','Fabric cost + CMTP.'],
    ['Margin',`Garment cost × ${(marginPct*100).toLocaleString('en-IN')}% from Rules Master.`],
    ['Final price','Garment cost + margin.'],
  ];
  const multipleColours = new Set(payload.fabric.lines.map(line => line.colour)).size > 1;
  return <div className="scw-final-sheet"><div className="table-scroll"><table className="wf-grid scw-final-grid">
    <thead><tr>{columns.map(([label,help]) => <th key={label} scope="col">{label} <span className="scw-column-info" title={help} aria-label={help} tabIndex={0}>ⓘ</span></th>)}</tr></thead>
    <tbody>{payload.fabric.lines.map((line,index) => {
      const garment = line.fabric_cost == null ? null : line.fabric_cost+cmtp;
      const margin = garment == null ? null : Math.round(garment*marginPct*100)/100;
      const final = garment == null || margin == null ? null : garment+margin;
      return <tr key={index}><th scope="row">{line.size || '—'}{multipleColours && <small>{line.colour || 'Unspecified colour'}</small>}</th><td>{format(line.fabric_cost)}</td><td>{format(cmtp)}</td><td>{format(garment)}</td><td>{format(margin)}</td><td>{format(final)}</td></tr>;
    })}{!payload.fabric.lines.length && <tr><td colSpan={6} className="wf-empty-cell">Add fabric consumption and CMTP to calculate the final price.</td></tr>}</tbody>
    <tfoot><tr><th scope="row" colSpan={5}>PO AVG final price</th><td>{format(payload.rates.total_po_avg_cost)}</td></tr></tfoot>
  </table></div><p className="scw-final-formula">Final price = Garment (Fabric + CMTP) + Margin {(marginPct*100).toLocaleString('en-IN')}% (set in Rules Master).</p></div>;
}

function DocumentsOverview({ code, documents }: { code: string; documents: CostSnapshot['documents'] }) {
  return <div className="scw-document-overview">
    <p className="scw-document-intro">The documents behind this cost: the RFP sheet and the CAD plans, one card per plan type. Click an entry to open it. Manage CAD plans in Fabric Cost.</p>
    <section className="scw-rfp-section" aria-labelledby="scw-rfp-heading">
      <div className="scw-rfp-bar"><strong id="scw-rfp-heading">RFP sheet</strong>{documents.rfp_link ? <a href={documents.rfp_link} target="_blank" rel="noopener noreferrer">Open ↗</a> : <span className="wf-subtle">No sheet yet.</span>}</div>
    </section>
    <h3 className="scw-document-cards-title">CAD Plans uploaded files:</h3>
    <div className="scw-document-cards">{CAD_GROUPS.map(group => {
      const files = documents.files.filter(file => file.doc_group === group.key);
      return <section className="scw-document-card" key={group.key} aria-label={group.label}>
        <div className="scw-document-card-heading"><h3>{group.label}</h3><span>{files.length || '—'}</span></div>
        {files.length ? <CadPdfLinks code={code} files={files} /> : <p className="wf-subtle">No plan yet.</p>}
      </section>;
    })}</div>
    {documents.cad_link && <a className="scw-document-reference" href={documents.cad_link} target="_blank" rel="noopener noreferrer">Open CAD reference ↗</a>}
    <p className="scw-document-sop"><strong>SOP:</strong> CAD plans are plotted on the 8 m table.</p>
  </div>;
}

export function CadPdfLinks({ code, files }: { code: string; files: CostSnapshot['documents']['files'] }) {
  const [error, setError] = useState('');
  async function open(path: string) {
    const tab = window.open('about:blank', '_blank');
    if (tab) tab.opener = null;
    try {
      const url = await openWorkflowCad(code, path);
      if (tab) tab.location.href = url;
      else setError('Allow pop-ups to open the CAD PDF.');
    } catch (e) { tab?.close(); setError(e instanceof Error ? e.message : 'Could not open CAD.'); }
  }
  return <div className="scw-cads" aria-label="CAD plans">
    <strong>CAD plans</strong>
    {files.length ? files.map((file, i) => <span key={i}>{file.file_path ? <button className="wf-btn wf-btn-ghost wf-btn-sm" type="button" onClick={() => open(file.file_path!)}>{file.file_name ?? 'Open CAD PDF'}</button> : <a href={file.link_url ?? undefined} target="_blank" rel="noopener noreferrer">{file.remark || 'Open CAD plan'}</a>} <small>{file.doc_group.replaceAll('_', ' ')}{file.width ? ` · ${file.width} inches` : ''}</small></span>) : <span className="wf-subtle">No CAD uploaded.</span>}
    {error && <p role="alert">{error}</p>}
  </div>;
}

export function CostWorkflowHistory({ events, title = 'Submission and amendment history' }: { events: CostWorkflowEvent[]; title?: string }) {
  const [filter, setFilter] = useState('');
  const [page, setPage] = useState(0);
  const visible = events.filter(e => `${e.product_code} ${e.actor} ${e.reason} ${e.event}`.toLowerCase().includes(filter.toLowerCase()));
  return <section className="scw-panel" aria-label={title}>
    <h2>{title}</h2>
    <label className="field wf-field"><span>Search history</span><input value={filter} onChange={e => { setFilter(e.target.value); setPage(0); }} placeholder="Product, person or reason" /></label>
    {!visible.length && <p className="wf-subtle">No matching history.</p>}
    {visible.slice(page * 25, (page + 1) * 25).map(e => <details className="scw-event" key={e.id}>
      <summary><Link href={`/standard-cost/${encodeURIComponent(e.product_code)}`}>{e.product_code}</Link> · #{e.revision_id} · {e.event} · {date(e.created_at)} · {e.actor}</summary>
      <p>{e.reason}</p><p>{e.sections.map(s => SECTION_LABEL[s]).join(', ')}</p>
      <div className="table-scroll"><table className="wf-grid scw-change-table"><thead><tr><th>Field</th><th>Before</th><th>After</th></tr></thead><tbody>{costEventChanges(e).map((change,i) => <tr key={i}><td>{change.field}</td><td>{change.before}</td><td>{change.after}</td></tr>)}</tbody></table></div>
    </details>)}
    {visible.length > 25 && <div className="scw-actions"><button type="button" className="wf-btn wf-btn-ghost wf-btn-sm" disabled={page === 0} onClick={() => setPage(p => p-1)}>Previous</button><span>Page {page+1} of {Math.ceil(visible.length/25)} · {visible.length} events</span><button type="button" className="wf-btn wf-btn-ghost wf-btn-sm" disabled={(page+1)*25 >= visible.length} onClick={() => setPage(p => p+1)}>Next</button></div>}
  </section>;
}

/** The rate-only Material workflow records transitions in sd_approval_log. */
export function MaterialCostWorkflowHistory({ events, title = 'Standard Cost changelog — admin' }: { events: MaterialCostWorkflowEvent[]; title?: string }) {
  const [filter, setFilter] = useState('');
  const [page, setPage] = useState(0);
  const visible = events.filter(event => `${event.material_code} ${event.actor} ${event.reason} ${event.event}`.toLowerCase().includes(filter.toLowerCase()));
  return <section className="scw-panel" aria-label={title}>
    <h2>{title}</h2>
    <label className="field wf-field"><span>Search history</span><input value={filter} onChange={event => { setFilter(event.target.value); setPage(0); }} placeholder="Material, person or reason" /></label>
    {!visible.length && <p className="wf-subtle">No matching history.</p>}
    {visible.slice(page * 25, (page + 1) * 25).map(event => <details className="scw-event" key={event.id}>
      <summary><Link href={`/standard-cost/${encodeURIComponent(event.material_code)}?track=material`}>{event.material_code}</Link> · {event.event} · {date(event.created_at)} · {event.actor}</summary>
      <p>{event.reason || 'No remark recorded.'}</p>
    </details>)}
    {visible.length > 25 && <div className="scw-actions"><button type="button" className="wf-btn wf-btn-ghost wf-btn-sm" disabled={page === 0} onClick={() => setPage(current => current - 1)}>Previous</button><span>Page {page + 1} of {Math.ceil(visible.length / 25)} · {visible.length} events</span><button type="button" className="wf-btn wf-btn-ghost wf-btn-sm" disabled={(page + 1) * 25 >= visible.length} onClick={() => setPage(current => current + 1)}>Next</button></div>}
  </section>;
}

export function CostWorkflowPanel({ code, initial, revisions, events, role, email, references, ready, error: unavailable, initiallyApproved, initiallyEditing = false, cmtpSubitems = {}, rateHistoryContent, trimHistoryContent, rateHistoryCount = 0, marginPct = 0, fabricBase = {}, rateCards }: {
  code: string; initial: CostSnapshot | null; revisions: CostRevision[]; events: CostWorkflowEvent[];
  role: string; email: string; references: { code: string; name: string }[]; ready: boolean; error?: string; initiallyApproved: boolean;
  initiallyEditing?: boolean;
  cmtpSubitems?: Record<string,string[]>;
  rateHistoryContent?: ReactNode;
  trimHistoryContent?: ReactNode;
  rateHistoryCount?: number;
  marginPct?: number;
  fabricBase?: FabricRates;
  rateCards?: ReactNode;
}) {
  const router = useRouter();
  const active = revisions.find(r => r.status !== 'approved') ?? null;
  const isNew = active ? active.kind === 'new' : !initiallyApproved;
  const [editing, setEditing] = useState(!!active || initiallyEditing);
  const [tab, setTab] = useState<AmendmentTab>('cmtp');
  const tabsId = useId();
  const [payload, setPayload] = useState<CostSnapshot | null>(() => {
    const source = active?.payload ?? (initial ? { ...initial, documents: isNew ? { ...initial.documents, files: [], cad_link: '' } : initial.documents } : null);
    return normalizeCadReference(source);
  });
  const [reason, setReason] = useState(active?.reason ?? '');
  const [remark, setRemark] = useState('');
  const [reference, setReference] = useState(active?.reference_code ?? '');

  const [error, setError] = useState('');
  const [busy, start] = useTransition();
  const [picked, setPicked] = useState<CostSection[]>([]);
  const [approvalTargets, setApprovalTargets] = useState(() => ({
    target_job: active?.payload.rates.target_job ?? null,
    target_fob: active?.payload.rates.target_fob ?? null,
    target_efob: active?.payload.rates.target_efob ?? null,
  }));
  const mayEdit = ['team','admin'].includes(role) && (!active || role === 'admin' || active.owner.toLowerCase() === email.toLowerCase());
  const locked = (section: CostSection) => !mayEdit || busy || !!active?.approved_sections.includes(section);
  const unsaved = !!active && (JSON.stringify(payload) !== JSON.stringify(normalizeCadReference(active.payload)) || reason !== active.reason || reference !== (active.reference_code ?? ''));
  if (!ready || !payload) return <section className="scw-panel"><p role="alert">{unavailable ?? 'Standard Cost workflow is unavailable.'}</p></section>;
  const standardRates = (active?.base ?? initial)?.rates;
  const rateOverrun = !isNew && (['job_cost','fob_cost','efob_cost'] as const).some(key => payload.rates[key] != null && standardRates?.[key] != null && payload.rates[key]! > standardRates[key]!);

  function update(section: CostSection, value: CostSnapshot[CostSection]) { setPayload(p => p ? { ...p, [section]: value } : p); }
  function act(op: 'save' | 'submit' | 'approve' | 'reject' | 'rework') {
    setError('');
    start(async () => {
      const decisionPayload = op === 'approve' && isNew ? { ...payload!, rates: { ...payload!.rates, ...approvalTargets } } : payload!;
      const result = await saveCostWorkflow({ code, op, id: active?.id ?? null, version: active?.version ?? 0, payload: decisionPayload, baseline: initial!, reason: ['approve','reject','rework'].includes(op) ? remark : isNew ? 'Initial standard cost submission' : reason, reference: reference || null, sections: picked });
      if (!result.ok) setError(result.error);
      else { router.refresh(); }
    });
  }
  function chooseReference(value: string) {
    setReference(value);
    if (!value) return;
    start(async () => {
      try {
        const copied = copyCostReference(await loadReferenceCost(value));
        setPayload(current => {
          for (const key of ['target_job','target_fob','target_efob'] as const) {
            delete copied.rates[key];
            if (current && key in current.rates) copied.rates[key] = current.rates[key];
          }
          return copied;
        });
      }
      catch (e) { setError(e instanceof Error ? e.message : 'Could not load reference.'); }
    });
  }
  function upload(file: File | undefined) {
    if (!file) return;
    start(async () => {
      try {
        const token = await workflowCadUpload(code, file.name, file.size);
        const result = await createClient().storage.from(COST_DOC_BUCKET).uploadToSignedUrl(token.path, token.token, file, { contentType: 'application/pdf' });
        if (result.error) throw result.error;
        setPayload(p => p ? { ...p, documents: { ...p.documents, files: [...p.documents.files, { file_path: token.path, file_name: file.name, file_size: file.size, doc_group: 'single_piece', width: null, link_url: null, remark: null }] } } : p);
      } catch (e) { setError(e instanceof Error ? e.message : 'Upload failed.'); }
    });
  }
  return <>
    <section className="scw-panel" aria-label="Standard Cost workflow">
      <div className="scw-heading"><div><h2>{isNew ? 'Add Standard Cost' : 'Amend/Update Standard Cost'}</h2><p className="wf-subtle">{isNew ? 'Complete every cost field, upload a CAD PDF and submit the full cost for approval.' : 'Change the sections you need, upload an updated CAD PDF file and submit for approval. Each changed section can be approved separately.'}</p></div>
        {mayEdit && <button type="button" className="wf-btn wf-btn-primary" onClick={() => setEditing(v => !v)}>{editing ? 'Close editor' : isNew ? 'Create submission' : 'Start amendment'}</button>}
      </div>
      {active && <p><b>#{active.id} · {active.status}</b> · Owner: {active.owner}{active.approved_sections.length ? ` · Approved: ${active.approved_sections.map(s => SECTION_LABEL[s]).join(', ')}` : ''}</p>}
      {(editing || active?.status === 'pending') && <>
        {isNew && mayEdit && <div className="scw-reference">
          <label className="field wf-field"><span>Load similar product cost</span><Combobox ariaLabel="Reference product" value={reference} onChange={chooseReference} disabled={busy} allowFreeText={false} placeholder="Search product code or name" options={references.filter(r => r.code !== code).map(r => ({value:r.code,label:r.name || r.code,detail:r.code}))} /></label>
          <p className="wf-subtle">Prefills rates, fabric and size rows, CMTP and RFP. Review and adjust the values; upload a fresh CAD PDF.</p>
        </div>}

        <fieldset className="scw-proposal-fieldset" disabled={locked('rates')}><legend className="scw-visually-hidden">Proposed rates and targets</legend><div className="table-scroll"><table className="scw-proposal-grid">
          <thead><tr><th scope="col" aria-label="Rate type" /><th scope="col">JOB</th><th scope="col">FOB</th><th scope="col">E-FOB</th><th scope="col">EXPECTED <small>(optional)</small></th></tr></thead>
          <tbody><tr><th scope="row">Proposed</th>{(['job_cost','fob_cost','efob_cost'] as const).map(key => <td key={key}><input type="number" min="0" step="any" aria-label={`${key.replaceAll('_',' ')} *`} value={payload.rates[key] ?? ''} onChange={e => update('rates',{...payload.rates,[key]:numeric(e.target.value)})} /></td>)}<td><input type="number" min="0" step="any" aria-label="Expected cost (optional)" value={payload.rates.proposed_cost ?? ''} onChange={e => update('rates',{...payload.rates,proposed_cost:numeric(e.target.value)})} /></td></tr>
          <tr className="scw-proposal-target"><th scope="row">Target</th>{(['target_job','target_fob','target_efob'] as const).map((key,index) => <td key={key}><input type="number" aria-label={`${['JOB','FOB','E-FOB'][index]} target`} disabled value={payload.rates[key] ?? ''} placeholder={isNew ? 'Set at first approval' : '—'} /></td>)}<td /></tr></tbody>
        </table></div><p className="scw-proposal-definition"><strong>Proposed:</strong> the rates submitted for approval; approved JOB, FOB and E-FOB become the live standard. <strong>Target:</strong> the approver’s benchmark, set during the first cost approval. <strong>Expected:</strong> an optional internal estimate.</p></fieldset>
        {<div className="scw-amend-tabs-row">
          <div className="segment scw-amend-tabs" role="tablist" aria-label="Amendment cost sections">
            {AMENDMENT_TABS.map((item,index) => <button key={item.key} type="button" role="tab" id={`${tabsId}-${item.key}-tab`} aria-controls={`${tabsId}-${item.key}-panel`} aria-selected={tab === item.key} tabIndex={tab === item.key ? 0 : -1} className={tab === item.key ? 'active' : ''} onClick={() => setTab(item.key)} onKeyDown={event => {
              const next = event.key === 'ArrowRight' ? (index+1)%AMENDMENT_TABS.length : event.key === 'ArrowLeft' ? (index+AMENDMENT_TABS.length-1)%AMENDMENT_TABS.length : event.key === 'Home' ? 0 : event.key === 'End' ? AMENDMENT_TABS.length-1 : null;
              if (next === null) return;
              event.preventDefault(); setTab(AMENDMENT_TABS[next].key);
              event.currentTarget.parentElement?.querySelectorAll<HTMLButtonElement>('[role="tab"]')[next]?.focus();
            }}>{item.label}{item.key === 'history' ? ` (${rateHistoryCount})` : ''}</button>)}
          </div>
          <p>Final = Fabric + CMTP (computed). Two owners: Fabric — the Fabric Cost master · CMTP — the costing team.</p>
        </div>}

        <div className="scw-amend-section" id={`${tabsId}-rates-panel`} role="tabpanel" aria-labelledby={`${tabsId}-rates-tab`} hidden={tab !== 'rates'}>
        <FinalCostTable payload={payload} marginPct={marginPct} /><details open={isNew || undefined} className="scw-final-rate-editor"><summary>Edit rates</summary><fieldset disabled={locked('rates')}><legend>{SECTION_LABEL.rates}</legend><div className="wf-form-grid">{(['total_po_avg_cost'] as const).map(key => <label className="field wf-field" key={key}><span>{key.replaceAll('_',' ')} <span className="scw-required" aria-label="required">*</span></span><input type="number" min="0" step="any" value={payload.rates[key] ?? ''} onChange={e => update('rates', { ...payload.rates, [key]: numeric(e.target.value) })} /></label>)}</div></fieldset></details>
        </div>
        <div className="scw-amend-section" id={`${tabsId}-fabric-panel`} role="tabpanel" aria-labelledby={`${tabsId}-fabric-tab`} hidden={tab !== 'fabric'}>
        <CadPdfLinks code={code} files={payload.documents.files} />
        <fieldset className="scw-fabric-cad-editor" disabled={locked('documents')}><legend>CAD Plan &amp; RFP Sheet inputs</legend>
          <label className="field wf-field"><span>Input RFP Sheet Link <span className="scw-required" aria-label="required">*</span></span><input aria-label="Input RFP Sheet Link" type="url" required={isNew} value={payload.documents.rfp_link} onChange={event => update('documents',{...payload.documents,rfp_link:event.target.value})} /></label>
          <section className="scw-cad-link-inputs" aria-labelledby="scw-cad-links-heading"><h3 id="scw-cad-links-heading">Input CAD Plan links <span className="scw-required" aria-label="required">*</span></h3>
            {payload.documents.files.map((file,i) => <div className="scw-file scw-cad-file-row" key={i}><span>{file.file_name ?? 'CAD link'}</span>{!file.file_path && <input aria-label={`CAD link ${i+1}`} type="url" required aria-required value={file.link_url ?? ''} onChange={e => update('documents',{...payload.documents,files:payload.documents.files.map((f,j) => j===i?{...f,link_url:e.target.value}:f)})} />}<select aria-label={`CAD group ${i+1}`} value={file.doc_group} onChange={e => update('documents',{...payload.documents,files:payload.documents.files.map((f,j) => j===i?{...f,doc_group:e.target.value}:f)})}>{['single_piece','full_layer','standard_ratio','ratio_1_1'].map(g => <option key={g} value={g}>{g.replaceAll('_',' ')}</option>)}</select>{file.doc_group==='full_layer' && <input aria-label={`CAD fabric width ${i+1}`} placeholder="Width in inches" value={file.width ?? ''} onChange={e => update('documents',{...payload.documents,files:payload.documents.files.map((f,j) => j===i?{...f,width:e.target.value}:f)})} />}<input className="scw-cad-remark" aria-label={`CAD remark ${i+1}`} placeholder="Remark" value={file.remark ?? ''} onChange={e => update('documents',{...payload.documents,files:payload.documents.files.map((f,j) => j===i?{...f,remark:e.target.value}:f)})} /><button type="button" className="wf-btn wf-btn-ghost wf-btn-sm" onClick={() => update('documents',{...payload.documents,files:payload.documents.files.filter((_,j) => j!==i)})}>Remove</button></div>)}
            <div className="scw-cad-link-actions" aria-label="Add CAD links">{CAD_GROUPS.filter(group => !payload.documents.files.some(file => !file.file_path && file.doc_group === group.key)).map(group => <button key={group.key} type="button" className="wf-btn wf-btn-ghost wf-btn-sm" onClick={() => update('documents',{...payload.documents,files:[...payload.documents.files,{file_path:null,file_name:null,file_size:null,doc_group:group.key,width:null,link_url:'',remark:null}]})}>Add CAD link — {group.label}</button>)}</div>
          </section>
          <label className="field wf-field"><span>Upload CAD PDF File <span className="scw-required" aria-label="required">*</span></span><input aria-label="Upload CAD PDF File" aria-required required type="file" accept="application/pdf,.pdf" onChange={e => {upload(e.target.files?.[0]);e.target.value='';}} /></label>
        </fieldset>
        <AmendmentFabric value={payload.fabric} onChange={value => update('fabric',value)} fabricBase={fabricBase} disabled={locked('fabric')} /><details open={isNew || undefined} className="scw-fabric-details"><summary>Extra fabrics</summary><fieldset disabled={locked('fabric')}><legend>Extra fabrics</legend><div className="table-scroll"><table className="wf-grid"><thead><tr>{['Fabric code','Size','Position','Unit','Consumption','Fabric cost',''].map((h,i) => <th key={i}>{h}</th>)}</tr></thead><tbody>{payload.fabric.extras.map((row,i) => <tr key={i}>{(['fabric_code','size','position','uom','consumption','fabric_cost'] as const).map(key => <td key={key}>{key === 'uom' ? <select aria-label={`Extra fabric unit ${i+1}`} value={row.uom} onChange={e => update('fabric', { ...payload.fabric, extras: payload.fabric.extras.map((l,j) => j===i ? { ...l,uom:e.target.value as 'mtr'|'kg' } : l) })}><option value="mtr">Metre</option><option value="kg">Kg</option></select> : <input aria-label={`Extra ${key} row ${i+1}`} type={key==='fabric_code'||key==='size' ? 'text':'number'} min="0" step="any" value={row[key] ?? ''} onChange={e => update('fabric', { ...payload.fabric, extras: payload.fabric.extras.map((l,j) => j===i ? { ...l,[key]: key==='fabric_code'||key==='size' ? e.target.value : numeric(e.target.value) } : l) })} />}</td>)}<td><button type="button" onClick={() => update('fabric', { ...payload.fabric,extras:payload.fabric.extras.filter((_,j) => j!==i) })}>Remove</button></td></tr>)}</tbody></table></div>
        <button type="button" className="wf-btn wf-btn-ghost wf-btn-sm" onClick={() => update('fabric', { ...payload.fabric,extras:[...payload.fabric.extras,{fabric_code:'',size:'',position:1,uom:'mtr',consumption:null,fabric_cost:null}] })}>Add extra fabric</button></fieldset></details>{<div className="scw-fabric-rate-cards">{[['Job rate',payload.rates.job_cost],['FOB rate',payload.rates.fob_cost],['E-FOB rate',payload.rates.efob_cost]].map(([label,amount]) => <div key={String(label)}><span>{label}</span><strong>{amount == null ? '—' : `₹${amount}`}</strong></div>)}</div>}
        </div>
        <div id={`${tabsId}-cmtp-panel`} role="tabpanel" aria-labelledby={`${tabsId}-cmtp-tab`} hidden={tab !== 'cmtp'}>
        <fieldset className="scw-amend-cmtp-fieldset" disabled={locked('cmtp')}><legend>CMTP</legend><AmendmentCmtp value={payload.cmtp} onChange={lines => update('cmtp',lines)} subitems={cmtpSubitems} afterTotal={rateCards} /></fieldset>
        </div>
        <div className="scw-amend-section" id={`${tabsId}-documents-panel`} role="tabpanel" aria-labelledby={`${tabsId}-documents-tab`} hidden={tab !== 'documents'}>
        <DocumentsOverview code={code} documents={payload.documents} />{<div className="scw-fabric-rate-cards scw-document-rates">{[['Job rate',payload.rates.job_cost],['FOB rate',payload.rates.fob_cost],['E-FOB rate',payload.rates.efob_cost],['Proposed',null],['Target',null]].map(([label,amount]) => <div key={String(label)}><span>{label}</span><strong>{amount == null ? '—' : `₹${amount}`}</strong></div>)}</div>}
        </div>

        {<>
          <div className="scw-amend-section scw-history-tab scw-rate-history" id={`${tabsId}-history-panel`} role="tabpanel" aria-labelledby={`${tabsId}-history-tab`} hidden={tab !== 'history'}>{rateHistoryContent ?? <CostWorkflowHistory events={events.filter(event => event.sections.includes('rates'))} title="Rate amendment history" />}</div>
          <div className="scw-amend-section scw-history-tab scw-trim-history" id={`${tabsId}-trims-panel`} role="tabpanel" aria-labelledby={`${tabsId}-trims-tab`} hidden={tab !== 'trims'}>{trimHistoryContent ?? <p className="wf-subtle">No trim history available.</p>}</div>
          {!isNew && <label className="field wf-field scw-amend-reason"><span>{rateOverrun ? 'Reason for cost overrun' : 'Amendment reason'} <span className="scw-required" aria-label="required">*</span></span>{rateOverrun && <small>The proposed rate exceeds the current approved standard cost.</small>}<textarea value={reason} disabled={!mayEdit || busy} onChange={e => setReason(e.target.value)} /></label>}
        </>}
        {mayEdit && <div className="scw-actions"><button className="wf-btn wf-btn-ghost" disabled={busy} type="button" onClick={() => act('save')}>Save draft / changes</button><button className="wf-btn wf-btn-primary" disabled={busy} type="button" onClick={() => act('submit')}>{active?.status==='rework'||active?.status==='rejected'?'Resubmit for approval':'Submit for approval'}</button></div>}
      </>}
      {role==='admin' && active?.status==='pending' && <div className="scw-review"><h3>{isNew?'Approve full submission':'Approve amendment sections'}</h3>{unsaved && <p role="status">Save your changes before approving.</p>}<p>Review the submitted values and CAD plans above. Approved values below remain in use until each section is approved.</p>{isNew && <fieldset className="scw-approval-targets"><legend>Set target rates for this first approval</legend><p className="wf-subtle">These benchmarks are retained for future amendments.</p><div className="wf-form-grid">{(['target_job','target_fob','target_efob'] as const).map((key,index) => <label className="field wf-field" key={key}><span>{['JOB','FOB','E-FOB'][index]} target <span className="scw-required" aria-label="required">*</span></span><input type="number" min="0" step="any" aria-label={`${['JOB','FOB','E-FOB'][index]} approval target`} value={approvalTargets[key] ?? ''} onChange={event => setApprovalTargets(current => ({ ...current, [key]: numeric(event.target.value) }))} /></label>)}</div></fieldset>}{!isNew && active.sections.filter(s => !active.approved_sections.includes(s)).map(s => <label key={s}><input type="checkbox" checked={picked.includes(s)} onChange={e => setPicked(p => e.target.checked?[...p,s]:p.filter(x => x!==s))} /> {SECTION_LABEL[s]}</label>)}<label className="field wf-field"><span>Decision remark (required for rework / reject)</span><textarea value={remark} onChange={e => setRemark(e.target.value)} disabled={busy} /></label><div className="scw-actions"><button type="button" className="wf-btn wf-btn-primary" disabled={busy||unsaved||(!isNew&&!picked.length)||(isNew && Object.values(approvalTargets).some(value => value == null || value < 0))} onClick={() => act('approve')}>{isNew?'Approve full standard cost':'Approve selected sections'}</button><button type="button" className="wf-btn wf-btn-ghost" disabled={busy||!remark.trim()} onClick={() => act('rework')}>Send for rework</button><button type="button" className="wf-btn wf-btn-ghost" disabled={busy||!remark.trim()} onClick={() => act('reject')}>Reject</button></div></div>}
      {busy && <p role="status">Working…</p>}{error && <p role="alert" className="scw-error">{error}</p>}
    </section>
    {events.length > 0 && <CostWorkflowHistory events={events} title={isNew ? 'Submission history' : 'Amendment history'} />}
  </>;
}
