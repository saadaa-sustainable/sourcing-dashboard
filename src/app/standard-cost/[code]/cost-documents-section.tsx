'use client';

import { Fragment, useState, useTransition } from 'react';
import { ExternalLink, FileText, Paperclip, Plus, Save, Trash2 } from 'lucide-react';
import { createClient } from '@/lib/supabase/client';
import { addCostDocument, deleteCostDocument, saveCostLinks, signCostDocument, startCostDocumentUpload } from '@/lib/forms/actions';
import { Field, Notice } from '@/components/forms/form-layout';
import { confirmDelete } from '@/lib/confirm';
import { reloadWithToast, toastError } from '@/lib/toast';
import {
  CAD_HEADERS,
  COST_DOC_BUCKET,
  COST_DOC_EXTENSIONS,
  COST_DOC_GROUP_LABEL,
  costDocFileError,
  type CostDocGroup,
  type CostDocument,
} from '@/lib/cost-documents';
import type { SdRole } from '@/lib/forms/types';

const ACCEPT = COST_DOC_EXTENSIONS.map((e) => `.${e}`).join(',');
const day = (iso: string | null) =>
  iso ? new Date(iso).toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'Asia/Kolkata' }) : '—';
const kb = (n: number | null) => (n == null ? '' : n >= 1048576 ? `${(n / 1048576).toFixed(1)} MB` : `${Math.max(1, Math.round(n / 1024))} KB`);

/** Upload one file straight to storage through a server-issued signed URL. */
async function uploadFile(productCode: string, file: File): Promise<{ ok: true; path: string } | { ok: false; error: string }> {
  const bad = costDocFileError(file.name, file.size);
  if (bad) return { ok: false, error: bad };
  const ticket = await startCostDocumentUpload(productCode, file.name, file.size);
  if (!ticket.ok) return ticket;
  const { error } = await createClient()
    .storage.from(COST_DOC_BUCKET)
    .uploadToSignedUrl(ticket.path, ticket.token, file, { contentType: file.type || 'application/octet-stream' });
  if (error) return { ok: false, error: 'The file could not be uploaded. Check the connection and try again.' };
  return { ok: true, path: ticket.path };
}

/**
 * Standard Cost → Documents tab (2026-10-09): the RFP sheet link and the CAD plan library —
 * four primary headers (single piece; full layer single size per width, 58″ and 56″
 * separate; standard ratio; 1:1 size ratio), each with Add + remark. Laid out like the other
 * cost tabs; everything changes only under the page's Edit cost (editable).
 */
export function CostDocumentsSection({
  costId,
  rfpLink,
  productCode,
  docs,
  ready,
  editable,
  role,
  userEmail,
}: {
  costId: number;
  rfpLink: string | null;
  productCode: string;
  docs: CostDocument[];
  ready: boolean;
  editable: boolean;
  role: SdRole;
  userEmail: string;
}) {
  const [rfp, setRfp] = useState(rfpLink ?? '');
  const [busy, start] = useTransition();
  const me = userEmail.toLowerCase();
  const byGroup = (g: CostDocGroup) => docs.filter((d) => d.doc_group === g);

  function saveRfp() {
    const fd = new FormData();
    fd.set('id', String(costId));
    fd.set('rfp_link', rfp);
    start(async () => {
      const r = await saveCostLinks(fd);
      if (r.ok) reloadWithToast(r.message ?? 'Saved.');
      else toastError(r.error);
    });
  }

  return (
    <div className="wf-final-view">
      <div className="wf-form-grid">
        <Field label="RFP sheet link">
          {editable ? (
            <input value={rfp} placeholder="https://…" onChange={(e) => setRfp(e.target.value)} />
          ) : rfpLink ? (
            <a className="cd-open" href={rfpLink} target="_blank" rel="noopener noreferrer">
              Open the RFP sheet <ExternalLink size={12} aria-hidden="true" />
            </a>
          ) : (
            <span className="wf-subtle">Not linked yet</span>
          )}
        </Field>
      </div>

      {!ready ? (
        <Notice tone="warn">
          The CAD plan library needs the database update <code>20261009100000_cost_documents.sql</code> — run it in the Supabase SQL editor, then reload.
        </Notice>
      ) : (
        <div className="table-scroll">
          <table className="wf-grid wf-cost-lines cd-table">
            <thead>
              <tr>
                <th>CAD plan</th>
                <th>File</th>
                <th>Remark</th>
                <th>Added</th>
                {editable && <th aria-label="Remove" />}
              </tr>
            </thead>
            <tbody>
              {CAD_HEADERS.map((h) => (
                <Fragment key={h.key}>
                  <tr className="cd-group-row">
                    <td colSpan={editable ? 5 : 4}>
                      <b>{h.title}</b> <span className="wf-subtle">{h.hint}</span>
                    </td>
                  </tr>
                  {h.slots.map((slot) => (
                    <SlotRows
                      key={slot.group}
                      group={slot.group}
                      label={slot.label}
                      docs={byGroup(slot.group)}
                      productCode={productCode}
                      editable={editable}
                      canRemove={(d) => role === 'admin' || (d.created_by ?? '').toLowerCase() === me}
                    />
                  ))}
                </Fragment>
              ))}
            </tbody>
          </table>
        </div>
      )}

      <p className="wf-subtle">
        <b>SOP:</b> CAD plans are plotted on the 8 m table.
      </p>

      {editable && (
        <div className="wf-cost-detail-foot">
          <button type="button" className="wf-btn wf-btn-primary wf-btn-sm" onClick={saveRfp} disabled={busy}>
            <Save size={13} /> {busy ? 'Saving…' : 'Save'}
          </button>
        </div>
      )}
    </div>
  );
}

function SlotRows({
  group,
  label,
  docs,
  productCode,
  editable,
  canRemove,
}: {
  group: CostDocGroup;
  label: string;
  docs: CostDocument[];
  productCode: string;
  editable: boolean;
  canRemove: (d: CostDocument) => boolean;
}) {
  const [adding, setAdding] = useState(false);
  const cols = editable ? 5 : 4;
  return (
    <>
      {docs.length ? (
        docs.map((d, i) => <DocRow key={d.id} d={d} label={i === 0 ? label : ''} productCode={productCode} editable={editable} canRemove={canRemove(d)} />)
      ) : (
        <tr>
          <td className="cd-slot">{label}</td>
          <td colSpan={cols - 1} className="wf-subtle">No CAD plan yet</td>
        </tr>
      )}
      {editable && (
        <tr className="cd-add-row">
          <td />
          <td colSpan={cols - 1}>
            {adding ? (
              <AddPicker productCode={productCode} group={group} onCancel={() => setAdding(false)} />
            ) : (
              <button type="button" className="wf-btn wf-btn-ghost wf-btn-sm" onClick={() => setAdding(true)}>
                <Plus size={13} /> Add {label} plan
              </button>
            )}
          </td>
        </tr>
      )}
    </>
  );
}

function DocRow({ d, label, productCode, editable, canRemove }: { d: CostDocument; label: string; productCode: string; editable: boolean; canRemove: boolean }) {
  const [pending, start] = useTransition();

  function open() {
    start(async () => {
      const r = await signCostDocument(d.id);
      if ('url' in r) window.open(r.url, '_blank', 'noopener,noreferrer');
      else toastError(r.error);
    });
  }
  async function remove() {
    const ok = await confirmDelete({
      title: `Remove ${d.file_name}?`,
      body: `The file is deleted from the ${COST_DOC_GROUP_LABEL[d.doc_group]} plans of ${productCode}. This cannot be undone.`,
      confirmLabel: 'Remove',
    });
    if (!ok) return;
    const fd = new FormData();
    fd.set('id', String(d.id));
    start(async () => {
      const r = await deleteCostDocument(fd);
      if (r.ok) reloadWithToast(r.message ?? 'Removed.');
      else toastError(r.error);
    });
  }

  return (
    <tr>
      <td className="cd-slot">{label}</td>
      <td>
        <button type="button" className="cd-doc-name" onClick={open} disabled={pending} title="Open the file">
          <FileText size={13} aria-hidden="true" /> {d.file_name}
        </button>
        {d.file_size ? <span className="wf-subtle"> · {kb(d.file_size)}</span> : null}
      </td>
      <td>{d.remark || <span className="wf-subtle">—</span>}</td>
      <td className="wf-subtle">{day(d.created_at)}{d.created_by ? ` · ${d.created_by}` : ''}</td>
      {editable && (
        <td>
          {canRemove && (
            <button type="button" className="wf-icon-btn" disabled={pending} onClick={remove} aria-label={`Remove ${d.file_name}`} title="Remove">
              <Trash2 size={14} />
            </button>
          )}
        </td>
      )}
    </tr>
  );
}

function AddPicker({ productCode, group, onCancel }: { productCode: string; group: CostDocGroup; onCancel: () => void }) {
  const [file, setFile] = useState<File | null>(null);
  const [remark, setRemark] = useState('');
  const [err, setErr] = useState<string | null>(null);
  const [pending, start] = useTransition();

  function go() {
    setErr(null);
    if (!file) return setErr('Choose the file first.');
    start(async () => {
      const up = await uploadFile(productCode, file);
      if (!up.ok) return setErr(up.error);
      const fd = new FormData();
      fd.set('product_code', productCode);
      fd.set('doc_group', group);
      fd.set('file_path', up.path);
      fd.set('file_name', file.name);
      fd.set('file_size', String(file.size));
      fd.set('remark', remark.trim());
      const r = await addCostDocument(fd);
      if (r.ok) reloadWithToast(r.message ?? 'Added.');
      else setErr(r.error);
    });
  }

  return (
    <div className="cd-picker">
      <label className="cd-file">
        <Paperclip size={13} aria-hidden="true" />
        <span>{file ? file.name : 'Choose a file'}</span>
        <input
          type="file"
          accept={ACCEPT}
          onChange={(e) => {
            const f = e.target.files?.[0] ?? null;
            setErr(f ? costDocFileError(f.name, f.size) : null);
            setFile(f);
          }}
        />
      </label>
      <input className="cd-remark" value={remark} onChange={(e) => setRemark(e.target.value)} placeholder="Remark (e.g. marker efficiency, lay length)" aria-label="Remark" />
      <button type="button" className="wf-btn wf-btn-primary wf-btn-sm" disabled={pending || !file} onClick={go}>
        {pending ? 'Uploading…' : 'Add'}
      </button>
      <button type="button" className="wf-btn wf-btn-ghost wf-btn-sm" disabled={pending} onClick={onCancel}>
        Cancel
      </button>
      {err && <p className="cd-err">{err}</p>}
    </div>
  );
}
