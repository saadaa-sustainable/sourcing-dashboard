'use client';

import { useState, useTransition } from 'react';
import { ExternalLink, Paperclip, Plus, Save, Trash2 } from 'lucide-react';
import { createClient } from '@/lib/supabase/client';
import { addCostDocument, deleteCostDocument, saveCostLinks, signCostDocument, startCostDocumentUpload } from '@/lib/forms/actions';
import { Notice } from '@/components/forms/form-layout';
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
  iso ? new Date(iso).toLocaleDateString('en-IN', { day: 'numeric', month: 'short', timeZone: 'Asia/Kolkata' }) : '—';

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
 * Standard Cost → Documents tab (2026-10-09). Same layout as the CMTP tab (wf-cmtp-*): a
 * short intro, the RFP sheet in the summary bar, one card per CAD header (single piece; full
 * layer single size per width — 58″ and 56″ separate; standard ratio; 1:1 size ratio) with
 * the file count as its pill and each file as a line. Changes only under Edit cost.
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
  const canRemove = (d: CostDocument) => role === 'admin' || (d.created_by ?? '').toLowerCase() === me;

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
    <div className="wf-cmtp">
      <p className="wf-subtle">
        The documents behind this cost: the RFP sheet and the CAD plans, one card per plan type. Click a file to open it.
        {editable ? ' Add a plan under its card with a remark; remove one you no longer need.' : ' Press Edit cost to add or change them.'}
      </p>

      <div className="wf-cmtp-total cd-rfp">
        <span>RFP sheet</span>
        {editable ? (
          <input value={rfp} placeholder="Paste the RFP sheet link — https://…" aria-label="RFP sheet link" onChange={(e) => setRfp(e.target.value)} />
        ) : rfpLink ? (
          <a href={rfpLink} target="_blank" rel="noopener noreferrer">
            Open <ExternalLink size={12} aria-hidden="true" />
          </a>
        ) : (
          <strong className="cd-none">Not linked</strong>
        )}
      </div>

      {!ready ? (
        <Notice tone="warn">
          The CAD plans need the database update <code>20261009100000_cost_documents.sql</code> — run it in the Supabase SQL editor, then reload.
        </Notice>
      ) : (
        <div className="wf-cmtp-heads cd-heads">
          {CAD_HEADERS.map((h) => {
            const count = h.slots.reduce((n, s) => n + byGroup(s.group).length, 0);
            return (
              <div key={h.key} className="wf-cmtp-head">
                <div className="wf-cmtp-head-row">
                  <span className="wf-cmtp-head-name" title={h.hint}>{h.title}</span>
                  <span className="wf-cmtp-sub wf-cell-calc">{count || '—'}</span>
                </div>
                {h.slots.map((slot) => (
                  <SlotLines
                    key={slot.group}
                    group={slot.group}
                    label={h.slots.length > 1 ? slot.label : null}
                    docs={byGroup(slot.group)}
                    productCode={productCode}
                    editable={editable}
                    canRemove={canRemove}
                  />
                ))}
              </div>
            );
          })}
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

function SlotLines({
  group,
  label,
  docs,
  productCode,
  editable,
  canRemove,
}: {
  group: CostDocGroup;
  label: string | null;
  docs: CostDocument[];
  productCode: string;
  editable: boolean;
  canRemove: (d: CostDocument) => boolean;
}) {
  const [adding, setAdding] = useState(false);
  return (
    <>
      {label && <small className="cd-slot-label">{label}</small>}
      {docs.map((d) => (
        <DocLine key={d.id} d={d} productCode={productCode} editable={editable && canRemove(d)} />
      ))}
      {!docs.length && <small className="wf-subtle">{editable ? 'No plan yet — add one below.' : 'No plan yet.'}</small>}
      {editable && (
        <div className="wf-cmtp-add">
          {adding ? (
            <AddPicker productCode={productCode} group={group} onCancel={() => setAdding(false)} />
          ) : (
            <button type="button" className="wf-chip-btn" onClick={() => setAdding(true)}>
              <Plus size={12} /> Add {label ?? 'plan'}
            </button>
          )}
        </div>
      )}
    </>
  );
}

function DocLine({ d, productCode, editable }: { d: CostDocument; productCode: string; editable: boolean }) {
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
    <div className="wf-cmtp-line is-filled">
      <button
        type="button"
        className="wf-cmtp-label wf-cmtp-label-text cd-file-line"
        onClick={open}
        disabled={pending}
        title={`${d.file_name}${d.remark ? ` — ${d.remark}` : ''} · open`}
      >
        <span className="cd-file-name">{d.file_name}</span>
        {d.remark && <span className="cd-file-remark">{d.remark}</span>}
      </button>
      <span className="wf-cmtp-amt wf-cmtp-amt-text cd-file-date" title={d.created_by ? `Added by ${d.created_by}` : undefined}>{day(d.created_at)}</span>
      {editable && (
        <button type="button" className="wf-icon-btn" disabled={pending} onClick={remove} aria-label={`Remove ${d.file_name}`} title="Remove">
          <Trash2 size={13} />
        </button>
      )}
    </div>
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
        <Paperclip size={12} aria-hidden="true" />
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
      <input value={remark} onChange={(e) => setRemark(e.target.value)} placeholder="Remark" aria-label="Remark" />
      <span className="cd-picker-actions">
        <button type="button" className="wf-btn wf-btn-primary wf-btn-sm" disabled={pending || !file} onClick={go}>
          {pending ? 'Adding…' : 'Add'}
        </button>
        <button type="button" className="wf-btn wf-btn-ghost wf-btn-sm" disabled={pending} onClick={onCancel}>
          Cancel
        </button>
      </span>
      {err && <small className="cd-err">{err}</small>}
    </div>
  );
}
