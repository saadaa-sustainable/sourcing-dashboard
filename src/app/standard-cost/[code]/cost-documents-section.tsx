'use client';

import { useState, useTransition } from 'react';
import { ExternalLink, Paperclip, Plus, Save, Trash2 } from 'lucide-react';
import { createClient } from '@/lib/supabase/client';
import { addCostDocument, addCostLink, deleteCostDocument, saveCostLinks, signCostDocument, startCostDocumentUpload } from '@/lib/forms/actions';
import { Notice } from '@/components/forms/form-layout';
import { confirmDelete } from '@/lib/confirm';
import { reloadWithToast, toastError } from '@/lib/toast';
import {
  CAD_HEADERS,
  COMMON_WIDTHS,
  COST_DOC_BUCKET,
  COST_DOC_EXTENSIONS,
  COST_DOC_GROUP_LABEL,
  costDocFileError,
  widthLabel,
  type CostDocGroup,
  type CostDocument,
} from '@/lib/cost-documents';
import type { SdRole } from '@/lib/forms/types';

const ACCEPT = COST_DOC_EXTENSIONS.map((e) => `.${e}`).join(',');
const LINK_RE = /^https?:\/\/\S+$/i;
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
 * short intro, the RFP sheet in the summary bar, one card per CAD header with the entry count
 * as its pill. Every card takes files (several at once) and/or shared links; Full layer · single
 * size per width also asks for the fabric width, as many widths as needed.
 * Changes only under Edit cost.
 */
export function CostDocumentsSection({
  costId,
  rfpLink,
  productCode,
  docs,
  ready,
  linksReady,
  editable,
  role,
  userEmail,
}: {
  costId: number;
  rfpLink: string | null;
  productCode: string;
  docs: CostDocument[];
  ready: boolean;
  linksReady: boolean;
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
        The documents behind this cost: the RFP sheet and the CAD plans, one card per plan type. Click an entry to open it.
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
            const entries = byGroup(h.key);
            return (
              <div key={h.key} className="wf-cmtp-head">
                <div className="wf-cmtp-head-row">
                  <span className="wf-cmtp-head-name" title={h.hint}>{h.title}</span>
                  <span className="wf-cmtp-sub wf-cell-calc">{entries.length || '—'}</span>
                </div>
                <PlanLines
                  group={h.key}
                  byWidth={h.byWidth}
                  docs={entries}
                  productCode={productCode}
                  editable={editable}
                  linksReady={linksReady}
                  canRemove={canRemove}
                />
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

/** A link's host, shown as its name ("docs.google.com"). */
function linkHost(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, '');
  } catch {
    return 'Link';
  }
}

function PlanLines({
  group,
  byWidth,
  docs,
  productCode,
  editable,
  linksReady,
  canRemove,
}: {
  group: CostDocGroup;
  byWidth: boolean;
  docs: CostDocument[];
  productCode: string;
  editable: boolean;
  linksReady: boolean;
  canRemove: (d: CostDocument) => boolean;
}) {
  const [adding, setAdding] = useState(false);
  const sorted = byWidth ? [...docs].sort((a, b) => (parseFloat(a.width ?? '') || 0) - (parseFloat(b.width ?? '') || 0) || a.id - b.id) : docs;
  const blocked = byWidth && !linksReady;
  return (
    <>
      {sorted.map((d) => (
        <DocLine key={d.id} d={d} productCode={productCode} editable={editable && canRemove(d)} />
      ))}
      {!docs.length && <small className="wf-subtle">{editable ? 'No plan yet — add one below.' : 'No plan yet.'}</small>}
      {editable &&
        (blocked ? (
          <small className="cd-err">Adding widths needs the database update 20261009130000_cost_document_width_links.sql.</small>
        ) : (
          <div className="wf-cmtp-add">
            {adding ? (
              <AddPicker
                productCode={productCode}
                group={group}
                byWidth={byWidth}
                linksReady={linksReady}
                taken={docs.map((d) => d.width ?? '')}
                onCancel={() => setAdding(false)}
              />
            ) : (
              <button type="button" className="wf-chip-btn" onClick={() => setAdding(true)}>
                <Plus size={12} /> {byWidth ? 'Add width' : 'Add plan'}
              </button>
            )}
          </div>
        ))}
    </>
  );
}

function DocLine({ d, productCode, editable }: { d: CostDocument; productCode: string; editable: boolean }) {
  const [pending, start] = useTransition();
  const source = d.link_url ? linkHost(d.link_url) : (d.file_name ?? 'Document');
  const name = d.width ? `${widthLabel(d.width)} width` : source;
  const sub = [d.width ? source : null, d.remark].filter(Boolean).join(' · ');

  function open() {
    if (d.link_url) {
      window.open(d.link_url, '_blank', 'noopener,noreferrer');
      return;
    }
    start(async () => {
      const r = await signCostDocument(d.id);
      if ('url' in r) window.open(r.url, '_blank', 'noopener,noreferrer');
      else toastError(r.error);
    });
  }
  async function remove() {
    const ok = await confirmDelete({
      title: `Remove ${name}?`,
      body: d.link_url
        ? `The link is removed from the ${COST_DOC_GROUP_LABEL[d.doc_group]} plans of ${productCode}. The linked file itself is not touched.`
        : `The file is deleted from the ${COST_DOC_GROUP_LABEL[d.doc_group]} plans of ${productCode}. This cannot be undone.`,
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
        title={`${name}${sub ? ` — ${sub}` : ''} · open`}
      >
        <span className="cd-file-name">
          {d.link_url ? <ExternalLink size={11} aria-hidden="true" /> : <Paperclip size={11} aria-hidden="true" />}
          {name}
        </span>
        {sub && <span className="cd-file-remark">{sub}</span>}
      </button>
      <span className="wf-cmtp-amt wf-cmtp-amt-text cd-file-date" title={d.created_by ? `Added by ${d.created_by}` : undefined}>{day(d.created_at)}</span>
      {editable && (
        <button type="button" className="wf-icon-btn" disabled={pending} onClick={remove} aria-label={`Remove ${name}`} title="Remove">
          <Trash2 size={13} />
        </button>
      )}
    </div>
  );
}

/**
 * Add to one card: any number of files and/or a link in one go (each becomes its own entry,
 * all with the same remark — and, on Full layer, the same width).
 */
function AddPicker({
  productCode,
  group,
  byWidth,
  linksReady,
  taken,
  onCancel,
}: {
  productCode: string;
  group: CostDocGroup;
  byWidth: boolean;
  linksReady: boolean;
  taken: string[];
  onCancel: () => void;
}) {
  const [files, setFiles] = useState<File[]>([]);
  const [width, setWidth] = useState('');
  const [link, setLink] = useState('');
  const [remark, setRemark] = useState('');
  const [err, setErr] = useState<string | null>(null);
  const [pending, start] = useTransition();
  const listId = `cd-widths-${productCode}`;
  const nothing = !files.length && !link.trim();

  function pick(list: FileList | null) {
    const picked = Array.from(list ?? []);
    const bad = picked.map((f) => costDocFileError(f.name, f.size) && `${f.name}: ${costDocFileError(f.name, f.size)}`).find(Boolean);
    setErr(bad || null);
    setFiles((prev) => [...prev, ...picked.filter((f) => !costDocFileError(f.name, f.size) && !prev.some((p) => p.name === f.name && p.size === f.size))]);
  }

  function go() {
    setErr(null);
    const w = width.trim();
    if (byWidth && !w) return setErr('Type or pick the fabric width.');
    if (nothing) return setErr('Choose a file or paste a link.');
    if (link.trim() && !LINK_RE.test(link.trim())) return setErr('Paste the full link, starting with https://');
    const base = () => {
      const fd = new FormData();
      fd.set('product_code', productCode);
      fd.set('doc_group', group);
      fd.set('remark', remark.trim());
      if (byWidth) fd.set('width', w);
      return fd;
    };
    start(async () => {
      let added = 0;
      for (const file of files) {
        const up = await uploadFile(productCode, file);
        if (!up.ok) return void (added ? reloadWithToast(`${added} added; ${file.name}: ${up.error}`) : setErr(`${file.name}: ${up.error}`));
        const fd = base();
        fd.set('file_path', up.path);
        fd.set('file_name', file.name);
        fd.set('file_size', String(file.size));
        const r = await addCostDocument(fd);
        if (!r.ok) return void (added ? reloadWithToast(`${added} added; ${file.name}: ${r.error}`) : setErr(r.error));
        added++;
      }
      if (link.trim()) {
        const fd = base();
        fd.set('link_url', link.trim());
        const r = await addCostLink(fd);
        if (!r.ok) return void (added ? reloadWithToast(`${added} added; the link: ${r.error}`) : setErr(r.error));
        added++;
      }
      reloadWithToast(added === 1 ? '1 plan added.' : `${added} plans added.`);
    });
  }

  return (
    <div className="cd-picker">
      {byWidth && (
        <>
          <input
            className="cd-width"
            value={width}
            list={listId}
            inputMode="decimal"
            placeholder="Fabric width, e.g. 58"
            aria-label="Fabric width (inches)"
            onChange={(e) => setWidth(e.target.value)}
          />
          <datalist id={listId}>
            {COMMON_WIDTHS.filter((w) => !taken.includes(w)).map((w) => (
              <option key={w} value={w}>
                {widthLabel(w)}
              </option>
            ))}
          </datalist>
        </>
      )}
      <label className="cd-file">
        <Paperclip size={12} aria-hidden="true" />
        <span>{files.length ? 'Add more files' : 'Choose files'}</span>
        <input
          type="file"
          multiple
          accept={ACCEPT}
          onChange={(e) => {
            pick(e.target.files);
            e.target.value = '';
          }}
        />
      </label>
      {files.length > 0 && (
        <ul className="cd-picked">
          {files.map((f, i) => (
            <li key={`${f.name}-${f.size}`}>
              <span>{f.name}</span>
              <button type="button" className="wf-icon-btn" aria-label={`Take ${f.name} off the list`} title="Take off the list" onClick={() => setFiles((p) => p.filter((_, j) => j !== i))}>
                ×
              </button>
            </li>
          ))}
        </ul>
      )}
      {linksReady && <input value={link} onChange={(e) => setLink(e.target.value)} placeholder="and / or paste a link — https://…" aria-label="Plan link" />}
      <input value={remark} onChange={(e) => setRemark(e.target.value)} placeholder="Remark" aria-label="Remark" />
      <span className="cd-picker-actions">
        <button type="button" className="wf-btn wf-btn-primary wf-btn-sm" disabled={pending || nothing || (byWidth && !width.trim())} onClick={go}>
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
