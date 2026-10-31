'use client';

import { useEffect, useState, useTransition } from 'react';
import { Upload } from 'lucide-react';
import { createClient } from '@/lib/supabase/client';
import { CAD_HEADERS, COST_DOC_GROUP_LABEL, type CostDocGroup } from '@/lib/cost-documents';
import { PO_CAD_BUCKET, poCadFileError, type PoCadDocument } from '@/lib/po-cad';
import { loadPoCadDocuments, startPoCadUpload, finishPoCadUpload, removePoCadDocument, openPoCadDocument } from './po-cad-actions';

export function PoCadPlans({ poId, editable = false, required = false }: { poId: number | null; editable?: boolean; required?: boolean }) {
  const [files, setFiles] = useState<PoCadDocument[]>([]);
  const [group, setGroup] = useState<CostDocGroup>('single_piece');
  const [width, setWidth] = useState('');
  const [remark, setRemark] = useState('');
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [loaded, setLoaded] = useState(false);
  const [pending, start] = useTransition();
  useEffect(() => {
    let alive = true;
    if (poId) void loadPoCadDocuments(poId).then(rows => { if (alive) { setFiles(rows); setLoaded(true); } }).catch(reason => { if (alive) { setError(reason instanceof Error ? reason.message : 'Could not load CAD plans.'); setLoaded(true); } });
    return () => { alive = false; };
  }, [poId]);
  function upload(file: File | undefined) {
    if (!file || !poId) return;
    const input = { name: file.name, size: file.size, group, width, remark };
    const invalid = poCadFileError(input);
    setNotice(''); setError(invalid ?? '');
    if (invalid) return;
    start(async () => {
      try {
        const ticket = await startPoCadUpload(poId, input);
        const { error: uploadError } = await createClient().storage.from(PO_CAD_BUCKET).uploadToSignedUrl(ticket.path, ticket.token, file, { contentType: 'application/pdf' });
        if (uploadError) throw new Error(uploadError.message);
        await finishPoCadUpload(ticket.id);
        setFiles(await loadPoCadDocuments(poId));
        setNotice('CAD PDF attached.'); setRemark('');
      } catch (reason) { setError(reason instanceof Error ? reason.message : 'CAD upload failed.'); }
    });
  }
  function remove(id: number) {
    setNotice(''); setError('');
    start(async () => {
      try { await removePoCadDocument(id); setFiles(current => current.filter(file => file.id !== id)); setNotice('CAD plan removed.'); }
      catch (reason) { setError(reason instanceof Error ? reason.message : 'Could not remove CAD plan.'); }
    });
  }
  async function open(id: number) {
    const tab = window.open('about:blank', '_blank');
    if (tab) tab.opener = null;
    try {
      const url = await openPoCadDocument(id);
      if (tab) tab.location.href = url;
      else setError('Allow pop-ups to open the CAD PDF.');
    } catch (reason) { tab?.close(); setError(reason instanceof Error ? reason.message : 'Could not open CAD plan.'); }
  }
  return (
    <section className="poa-cad-plans" aria-label="PO CAD plans">
      <div className="poa-cad-heading"><h4>CAD plans{required && <span className="poa-cad-required" aria-label="required"> *</span>}</h4><span className="poa-cad-count">{files.length} attached</span></div>
      <p className="poa-cad-help">{required ? 'Required: attach at least one CAD plan PDF before saving Cost or submitting the PO.' : 'View the CAD plans attached to this PO.'}</p>
      {editable && <div className="poa-cad-upload-grid">
        <label><span>Plan type</span><select aria-label="CAD plan type" value={group} onChange={event => setGroup(event.target.value as CostDocGroup)} disabled={pending || !poId}>{CAD_HEADERS.map(header => <option key={header.key} value={header.key}>{header.title}</option>)}</select></label>
        <label className="poa-cad-file-label">
          <span>Upload CAD PDF File{required && <span className="poa-cad-required" aria-hidden="true"> *</span>}</span>
          <span className="poa-cad-file-control">
            <input aria-label="Upload CAD PDF File" aria-required={required && files.length === 0} type="file" accept="application/pdf,.pdf" disabled={pending || !poId} onChange={event => { const file = event.currentTarget.files?.[0]; event.currentTarget.value = ''; upload(file); }} />
            <span className="poa-cad-file-button" aria-hidden="true"><Upload size={15} />{pending ? 'Uploading PDF…' : 'Choose PDF'}</span>
          </span>
          <small>PDF only · Up to 25 MB per file. Files attach automatically after upload.</small>
        </label>
        <label><span>Remark <span className="poa-cad-optional">(optional)</span></span><input aria-label="CAD remark" maxLength={2000} value={remark} onChange={event => setRemark(event.target.value)} disabled={pending || !poId} placeholder="Add a note about this plan" /></label>
        {group === 'full_layer' && <label className="poa-cad-width-label"><span>Fabric width (inches)<span className="poa-cad-required" aria-label="required"> *</span></span><input aria-label="CAD fabric width" aria-required type="number" min="0.01" step="any" value={width} onChange={event => setWidth(event.target.value)} disabled={pending || !poId} /></label>}
      </div>}
      {!poId && <p className="poa-cad-help">Save the Order step to attach CAD plans.</p>}
      {poId && !loaded && <p role="status">Loading CAD plans...</p>}
      {loaded && !files.length && !error && <p className="poa-cad-help">No CAD plans attached.</p>}
      {files.length > 0 && <ul className="poa-cad-list">{files.map(file => <li key={file.id}>
        <div><a className="poa-cad-open" href="#" onClick={event => { event.preventDefault(); void open(file.id); }}>{file.file_name}</a><small>{COST_DOC_GROUP_LABEL[file.doc_group]}{file.width ? ` / ${file.width} inches` : ''} / {(file.file_size / 1024 / 1024).toFixed(2)} MB</small>{file.remark && <p>{file.remark}</p>}</div>
        {editable && <button type="button" className="wf-btn wf-btn-ghost wf-btn-sm" disabled={pending} onClick={() => remove(file.id)} aria-label={`Remove ${file.file_name}`}>Remove</button>}
      </li>)}</ul>}
      {pending && <p role="status">Saving CAD plan...</p>}
      {error && <p role="alert" className="wf-error-text">{error}</p>}
      {notice && <p role="status" className="poa-cad-success">{notice}</p>}
    </section>
  );
}
