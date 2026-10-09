'use client';

import { useState, useTransition } from 'react';
import { FileText, Paperclip, Plus, Trash2 } from 'lucide-react';
import { createClient } from '@/lib/supabase/client';
import { addCostDocument, deleteCostDocument, signCostDocument, startCostDocumentUpload } from '@/lib/forms/actions';
import { canEdit } from '@/lib/forms/approval';
import { Notice } from '@/components/forms/form-layout';
import { InfoDot } from '@/components/info-dot';
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
 * Standard Cost → Documents tab (2026-10-09): the CAD plan library — four primary headers
 * (single piece; full layer single size per width, 58″ and 56″ separate; standard ratio;
 * 1:1 size ratio), each with Add + remark. No approval on documents. The RFP and CAD links
 * stay on the Final Cost tab.
 */
export function CostDocumentsSection({
  productCode,
  docs,
  ready,
  role,
  userEmail,
}: {
  productCode: string;
  docs: CostDocument[];
  ready: boolean;
  role: SdRole;
  userEmail: string;
}) {
  const editor = canEdit(role, 'draft');
  const me = userEmail.toLowerCase();
  const byGroup = (g: CostDocGroup) => docs.filter((d) => d.doc_group === g);

  return (
    <section className="cd-section" aria-label="CAD plan library">
      {!ready ? (
        <Notice tone="warn">
          The CAD plan library needs the database update <code>20261009100000_cost_documents.sql</code> — run it in the Supabase SQL editor, then reload.
        </Notice>
      ) : (
        <div className="cd-library">
          <div className="cd-library-head">
            <h3>
              CAD plan library
              <InfoDot text={"WHAT: the CAD plans (markers) for this product.\n\nHOW: add each plan under its group with a remark; click a file to open it.\n\nUSE: one place to find the right CAD for the lay being cut. The RFP sheet and CAD links stay on Final Cost."} />
            </h3>
            <p className="cd-sop">
              <b>SOP</b> CAD plans are plotted on the 8 m table.
            </p>
          </div>
          {CAD_HEADERS.map((h) => (
            <div className="cd-group" key={h.key}>
              <div className="cd-group-head">
                <h4>{h.title}</h4>
                <span>{h.hint}</span>
              </div>
              <div className={`cd-slots${h.slots.length > 1 ? ' split' : ''}`}>
                {h.slots.map((slot) => (
                  <Slot
                    key={slot.group}
                    group={slot.group}
                    label={h.slots.length > 1 ? slot.label : null}
                    docs={byGroup(slot.group)}
                    productCode={productCode}
                    editor={editor}
                    isAdmin={role === 'admin'}
                    me={me}
                  />
                ))}
              </div>
            </div>
          ))}
        </div>
      )}
    </section>
  );
}

function Slot({
  group,
  label,
  docs,
  productCode,
  editor,
  isAdmin,
  me,
}: {
  group: CostDocGroup;
  label: string | null;
  docs: CostDocument[];
  productCode: string;
  editor: boolean;
  isAdmin: boolean;
  me: string;
}) {
  const [adding, setAdding] = useState(false);
  return (
    <div className="cd-slot">
      {label && <div className="cd-slot-label">{label}</div>}
      {docs.length ? (
        <ul className="cd-docs">
          {docs.map((d) => (
            <DocRow key={d.id} d={d} productCode={productCode} canRemove={isAdmin || (editor && (d.created_by ?? '').toLowerCase() === me)} />
          ))}
        </ul>
      ) : (
        <p className="cd-empty">No CAD plan yet.</p>
      )}
      {editor &&
        (adding ? (
          <AddPicker productCode={productCode} group={group} onCancel={() => setAdding(false)} />
        ) : (
          <button type="button" className="wf-btn wf-btn-ghost wf-btn-sm cd-add" onClick={() => setAdding(true)}>
            <Plus size={13} /> Add {label ? `${label} plan` : 'plan'}
          </button>
        ))}
    </div>
  );
}

function DocRow({ d, productCode, canRemove }: { d: CostDocument; productCode: string; canRemove: boolean }) {
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
    <li className="cd-doc">
      <div className="cd-doc-main">
        <button type="button" className="cd-doc-name" onClick={open} disabled={pending} title="Open the file">
          <FileText size={14} aria-hidden="true" /> {d.file_name}
        </button>
        {canRemove && (
          <button type="button" className="wf-btn wf-btn-ghost wf-btn-sm" disabled={pending} onClick={remove} aria-label={`Remove ${d.file_name}`} title="Remove">
            <Trash2 size={12} />
          </button>
        )}
      </div>
      <div className="cd-doc-meta">
        {d.remark && <span className="cd-doc-remark">“{d.remark}”</span>}
        <span>{kb(d.file_size)}{d.file_size ? ' · ' : ''}added {day(d.created_at)}{d.created_by ? ` by ${d.created_by}` : ''}</span>
      </div>
    </li>
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
      <div className="cd-picker-actions">
        <button type="button" className="wf-btn wf-btn-primary wf-btn-sm" disabled={pending || !file} onClick={go}>
          {pending ? 'Uploading…' : 'Add'}
        </button>
        <button type="button" className="wf-btn wf-btn-ghost wf-btn-sm" disabled={pending} onClick={onCancel}>
          Cancel
        </button>
      </div>
      {err && <p className="cd-err">{err}</p>}
    </div>
  );
}
