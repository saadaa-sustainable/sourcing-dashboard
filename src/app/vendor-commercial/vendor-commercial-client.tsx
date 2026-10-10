'use client';

import { useMemo, useState, useTransition } from 'react';
import { BadgeIndianRupee, Download, Paperclip, Pencil, X } from 'lucide-react';
import { HeaderInfo } from '@/components/header-info';
import { Field, Notice, StatusBadge } from '@/components/forms/form-layout';
import { ApprovalBar } from '@/components/forms/approval-bar';
import { createClient } from '@/lib/supabase/client';
import { downloadCsv } from '@/lib/download';
import { confirmDelete } from '@/lib/confirm';
import { reloadWithToast, toastError } from '@/lib/toast';
import { canApprove, canEdit } from '@/lib/forms/approval';
import {
  createVendorCommercialRequest,
  signCommercialFile,
  startCommercialUpload,
  updateVendorCommercialRequest,
} from '@/lib/forms/actions';
import {
  ATTACHMENT_LABEL,
  BUSINESS_TYPES,
  COMMERCIAL_BUCKET,
  COMMERCIAL_EXTENSIONS,
  COST_REASONS,
  REMARKS_LABEL,
  REQUEST_TYPES,
  commercialFileError,
  commercialSummary,
  requestTypeLabel,
  type CommercialAttachment,
  type CommercialBusinessType,
  type CommercialRequestType,
} from '@/lib/forms/commercial';
import type { SdRole, VendorCommercialRequest } from '@/lib/forms/types';

const ACCEPT = COMMERCIAL_EXTENSIONS.map((e) => `.${e}`).join(',');
const fmtDate = (iso: string | null) =>
  iso ? new Date(iso).toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'Asia/Kolkata' }) : '—';

type Form = {
  business_type: CommercialBusinessType | '';
  vendor_code: string;
  vendor_name: string;
  po_numbers: string;
  request_type: CommercialRequestType | '';
  hold_qty: string;
  hold_days: string;
  ready_date: string;
  cost_reason: string;
  cost_reason_other: string;
  increment_amount: string;
  owner_name: string;
  owner_contact: string;
  invoice_number: string;
  invoice_date: string;
  invoice_amount: string;
  rg_pending: string;
  debit_note_number: string;
  credit_amount: string;
  remarks: string;
};
const EMPTY: Form = {
  business_type: '',
  vendor_code: '',
  vendor_name: '',
  po_numbers: '',
  request_type: '',
  hold_qty: '',
  hold_days: '',
  ready_date: '',
  cost_reason: '',
  cost_reason_other: '',
  increment_amount: '',
  owner_name: '',
  owner_contact: '',
  invoice_number: '',
  invoice_date: '',
  invoice_amount: '',
  rg_pending: '',
  debit_note_number: '',
  credit_amount: '',
  remarks: '',
};
const s = (v: unknown) => (v == null ? '' : String(v));

/** Upload one file straight to storage through a server-issued signed URL. */
async function uploadFile(vendorCode: string, file: File): Promise<{ ok: true; att: CommercialAttachment } | { ok: false; error: string }> {
  const bad = commercialFileError(file.name, file.size);
  if (bad) return { ok: false, error: `${file.name}: ${bad}` };
  const ticket = await startCommercialUpload(vendorCode, file.name, file.size);
  if (!ticket.ok) return ticket;
  const { error } = await createClient()
    .storage.from(COMMERCIAL_BUCKET)
    .uploadToSignedUrl(ticket.path, ticket.token, file, { contentType: file.type || 'application/octet-stream' });
  if (error) return { ok: false, error: `${file.name} could not be uploaded. Check the connection and try again.` };
  return { ok: true, att: { path: ticket.path, name: file.name, size: file.size } };
}

/**
 * Vendor Commercial Approval (2026-10-09) — the team's Google Form "COMMERCIAL APPROVAL FORM" on
 * the dashboard, same flow as Vendor De-Boarding: business type → firm / vendor code / PO →
 * type of request, then that request's own questions. It goes to the approval queue and always
 * needs an admin; until approved every field can be amended.
 */
export function VendorCommercialClient({
  requests,
  vendors,
  role,
}: {
  requests: VendorCommercialRequest[];
  vendors: { vendor_code: string; vendor_name: string | null; primary_type: string | null }[];
  role: SdRole;
}) {
  const editable = canEdit(role, 'draft');
  const [form, setForm] = useState<Form>(EMPTY);
  const [kept, setKept] = useState<CommercialAttachment[]>([]);
  const [files, setFiles] = useState<File[]>([]);
  const [editingId, setEditingId] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [typeFilter, setTypeFilter] = useState<CommercialRequestType | 'all'>('all');
  const [pending, start] = useTransition();
  const set = <K extends keyof Form>(k: K, v: Form[K]) => setForm((f) => ({ ...f, [k]: v }));
  const byCode = useMemo(() => new Map(vendors.map((v) => [v.vendor_code, v])), [vendors]);
  const b = form.business_type || null;
  const t = form.request_type || null;
  const takesFiles = t ? Boolean(ATTACHMENT_LABEL[t]) : false;

  function pickVendor(code: string) {
    const up = code.trim().toUpperCase();
    const v = byCode.get(up);
    setForm((f) => ({ ...f, vendor_code: up, vendor_name: v?.vendor_name ?? f.vendor_name }));
  }

  function reset() {
    setForm(EMPTY);
    setKept([]);
    setFiles([]);
    setEditingId(null);
    setError(null);
  }

  function startEdit(r: VendorCommercialRequest) {
    setError(null);
    setEditingId(r.id);
    setForm({
      business_type: r.business_type,
      vendor_code: r.vendor_code,
      vendor_name: s(r.vendor_name),
      po_numbers: r.po_numbers,
      request_type: r.request_type,
      hold_qty: s(r.hold_qty),
      hold_days: s(r.hold_days),
      ready_date: s(r.ready_date),
      cost_reason: s(r.cost_reason),
      cost_reason_other: s(r.cost_reason_other),
      increment_amount: s(r.increment_amount),
      owner_name: s(r.owner_name),
      owner_contact: s(r.owner_contact),
      invoice_number: s(r.invoice_number),
      invoice_date: s(r.invoice_date),
      invoice_amount: s(r.invoice_amount),
      rg_pending: s(r.rg_pending),
      debit_note_number: s(r.debit_note_number),
      credit_amount: s(r.credit_amount),
      remarks: r.remarks,
    });
    setKept(r.attachments ?? []);
    setFiles([]);
    window.scrollTo({ top: 0, behavior: 'smooth' });
  }

  async function dropKept(a: CommercialAttachment) {
    const ok = await confirmDelete({
      title: `Remove ${a.name}?`,
      body: 'The file is deleted from this request when you save it. This cannot be undone.',
      confirmLabel: 'Remove',
    });
    if (ok) setKept((k) => k.filter((x) => x.path !== a.path));
  }

  function pickFiles(list: FileList | null) {
    const picked = Array.from(list ?? []);
    const bad = picked.map((f) => commercialFileError(f.name, f.size) && `${f.name}: ${commercialFileError(f.name, f.size)}`).find(Boolean);
    setError(bad || null);
    setFiles((prev) => [...prev, ...picked.filter((f) => !commercialFileError(f.name, f.size) && !prev.some((p) => p.name === f.name && p.size === f.size))]);
  }

  const canSend =
    !!form.business_type &&
    !!form.vendor_code.trim() &&
    !!form.vendor_name.trim() &&
    !!form.po_numbers.trim() &&
    !!form.request_type &&
    !!form.remarks.trim() &&
    (t !== 'hold_waiver' || (form.hold_qty.trim() !== '' && form.hold_days.trim() !== '')) &&
    (t !== 'cost_increment' || (!!form.cost_reason && (form.cost_reason !== 'other' || !!form.cost_reason_other.trim())));

  function submit() {
    setError(null);
    start(async () => {
      const uploaded: CommercialAttachment[] = [];
      if (takesFiles) {
        for (const file of files) {
          const up = await uploadFile(form.vendor_code, file);
          if (!up.ok) return setError(toastError(up.error));
          uploaded.push(up.att);
        }
      }
      const fd = new FormData();
      for (const [k, v] of Object.entries(form)) fd.set(k, v);
      fd.set('attachments', JSON.stringify(takesFiles ? [...kept, ...uploaded] : []));
      if (editingId != null) fd.set('id', String(editingId));
      const r = editingId != null ? await updateVendorCommercialRequest(fd) : await createVendorCommercialRequest(fd);
      if (r.ok) {
        reset();
        reloadWithToast(r.message);
      } else setError(toastError(r.error));
    });
  }

  function openFile(id: number, a: CommercialAttachment) {
    start(async () => {
      const r = await signCommercialFile(id, a.path);
      if ('url' in r) window.open(r.url, '_blank', 'noopener,noreferrer');
      else toastError(r.error);
    });
  }

  const shown = typeFilter === 'all' ? requests : requests.filter((r) => r.request_type === typeFilter);

  function exportCsv() {
    downloadCsv(
      'vendor-commercial-approvals',
      ['Raised', 'Raised by', 'Business type', 'Vendor code', 'Firm', 'PO number', 'Type of request', 'Details', 'Remarks', 'Files', 'Status', 'Decided by', 'Decided on', 'Decision remarks'],
      shown.map((r) => [
        r.requested_at, r.requested_by, BUSINESS_TYPES.find((x) => x.key === r.business_type)?.label ?? r.business_type, r.vendor_code, r.vendor_name, r.po_numbers,
        requestTypeLabel(r.request_type, r.business_type), commercialSummary(r), r.remarks, r.attachments.map((a) => a.name).join('; '),
        r.status, r.approved_by, r.approved_at, r.rejection_notes || r.rework_notes,
      ]),
    );
  }

  return (
    <>
      <Notice tone="info">
        This replaces the Google Form. Pick the business type, the vendor and the PO, then the type of request — the form
        asks that request’s own questions. Every request goes to the approval queue and <strong>always needs an admin</strong>.
      </Notice>

      {error && <Notice tone="error">{error}</Notice>}

      {editable && (
        <div className="panel wf-form-panel">
          <div className="panel-title">
            <h3>{editingId != null ? `Amend request #${editingId}` : 'Raise a commercial approval request'}</h3>
          </div>

          <div className="wf-form-grid">
            <Field label="Business type">
              <select value={form.business_type} onChange={(e) => setForm((f) => ({ ...f, business_type: e.target.value as CommercialBusinessType | '', cost_reason: '', cost_reason_other: '' }))}>
                <option value="">Select…</option>
                {BUSINESS_TYPES.map((x) => (
                  <option key={x.key} value={x.key}>{x.label} ({x.hint})</option>
                ))}
              </select>
            </Field>
            <Field label="Vendor code" hint="Pick from the vendor master or type it">
              <input list="vc-vendors" value={form.vendor_code} onChange={(e) => pickVendor(e.target.value)} placeholder="e.g. KVN" />
              <datalist id="vc-vendors">
                {vendors.map((v) => (
                  <option key={v.vendor_code} value={v.vendor_code}>{v.vendor_name ?? ''}</option>
                ))}
              </datalist>
            </Field>
            <Field label="Firm name">
              <input value={form.vendor_name} onChange={(e) => set('vendor_name', e.target.value)} />
            </Field>
            <Field label="PO number" hint="Several POs: separate them with commas">
              <input value={form.po_numbers} onChange={(e) => set('po_numbers', e.target.value)} placeholder="FY26-27/FOB/…" />
            </Field>
            <Field label="Type of request">
              <select value={form.request_type} onChange={(e) => set('request_type', e.target.value as CommercialRequestType | '')}>
                <option value="">Select…</option>
                {REQUEST_TYPES.map((x) => (
                  <option key={x.key} value={x.key}>{requestTypeLabel(x.key, b)}</option>
                ))}
              </select>
            </Field>
          </div>

          {t === 'hold_waiver' && (
            <div className="wf-form-grid">
              <Field label="Total hold qty">
                <input type="number" min={0} value={form.hold_qty} onChange={(e) => set('hold_qty', e.target.value)} />
              </Field>
              <Field label="Total days hold asked by the SAADAA team">
                <input type="number" min={0} step={1} value={form.hold_days} onChange={(e) => set('hold_days', e.target.value)} />
              </Field>
              <Field label={`${b === 'fabric' ? 'Fabric' : 'Goods'} ready date`}>
                <input type="date" value={form.ready_date} onChange={(e) => set('ready_date', e.target.value)} />
              </Field>
            </div>
          )}

          {t === 'cost_increment' && (
            <div className="wf-form-grid">
              <Field label="Reason for commercial approval" hint={b ? undefined : 'Pick the business type first'}>
                <select value={form.cost_reason} disabled={!b} onChange={(e) => set('cost_reason', e.target.value)}>
                  <option value="">Select…</option>
                  {(b ? COST_REASONS[b] : []).map((r) => (
                    <option key={r.key} value={r.key}>{r.label}</option>
                  ))}
                </select>
              </Field>
              {form.cost_reason === 'other' && (
                <Field label="What is the other reason?">
                  <input value={form.cost_reason_other} onChange={(e) => set('cost_reason_other', e.target.value)} />
                </Field>
              )}
              <Field label="Increment amount requested (₹)" hint="Optional">
                <input inputMode="decimal" value={form.increment_amount} onChange={(e) => set('increment_amount', e.target.value)} />
              </Field>
            </div>
          )}

          {t === 'cash_discount' && (
            <div className="wf-form-grid">
              <Field label="Owner name">
                <input value={form.owner_name} onChange={(e) => set('owner_name', e.target.value)} />
              </Field>
              <Field label="Owner contact number">
                <input inputMode="tel" value={form.owner_contact} onChange={(e) => set('owner_contact', e.target.value)} />
              </Field>
              <Field label="Invoice number">
                <input value={form.invoice_number} onChange={(e) => set('invoice_number', e.target.value)} />
              </Field>
              <Field label="Invoice date">
                <input type="date" value={form.invoice_date} onChange={(e) => set('invoice_date', e.target.value)} />
              </Field>
              <Field label="Invoice amount (₹)">
                <input inputMode="decimal" value={form.invoice_amount} onChange={(e) => set('invoice_amount', e.target.value)} />
              </Field>
              <Field label="RG pending with vendor">
                <input value={form.rg_pending} onChange={(e) => set('rg_pending', e.target.value)} />
              </Field>
            </div>
          )}

          {t === 'dn_removal' && (
            <div className="wf-form-grid">
              <Field label="Debit note number">
                <input value={form.debit_note_number} onChange={(e) => set('debit_note_number', e.target.value)} />
              </Field>
            </div>
          )}

          {t === 'credit_note' && (
            <div className="wf-form-grid">
              <Field label="Amount (₹)">
                <input inputMode="decimal" value={form.credit_amount} onChange={(e) => set('credit_amount', e.target.value)} />
              </Field>
            </div>
          )}

          {t && (
            <>
              <Field label={REMARKS_LABEL[t]}>
                <textarea className="wf-textarea" rows={3} value={form.remarks} onChange={(e) => set('remarks', e.target.value)} />
              </Field>
              {takesFiles && (
                <div className="vcom-files">
                  <span className="vcom-files-label">{ATTACHMENT_LABEL[t]}</span>
                  {kept.map((a) => (
                    <span key={a.path} className="vcom-file">
                      <Paperclip size={12} aria-hidden="true" /> {a.name}
                      <button type="button" className="wf-icon-btn" aria-label={`Remove ${a.name}`} onClick={() => dropKept(a)}><X size={12} /></button>
                    </span>
                  ))}
                  {files.map((f, i) => (
                    <span key={`${f.name}-${f.size}`} className="vcom-file is-new">
                      <Paperclip size={12} aria-hidden="true" /> {f.name}
                      <button type="button" className="wf-icon-btn" aria-label={`Take ${f.name} off the list`} onClick={() => setFiles((p) => p.filter((_, j) => j !== i))}><X size={12} /></button>
                    </span>
                  ))}
                  <label className="cd-file">
                    <Paperclip size={12} aria-hidden="true" />
                    <span>{kept.length || files.length ? 'Add more files' : 'Choose files'}</span>
                    <input type="file" multiple accept={ACCEPT} onChange={(e) => { pickFiles(e.target.files); e.target.value = ''; }} />
                  </label>
                </div>
              )}
            </>
          )}

          <div className="wf-footer-actions">
            {editingId != null && (
              <button type="button" className="wf-btn wf-btn-ghost" onClick={reset} disabled={pending}>Cancel</button>
            )}
            <button type="button" className="wf-btn wf-btn-primary" onClick={submit} disabled={pending || !canSend}>
              <BadgeIndianRupee size={15} /> {pending ? 'Saving…' : editingId != null ? 'Save changes' : 'Submit for approval'}
            </button>
          </div>
        </div>
      )}

      <div className="table-panel">
        <div className="table-meta">
          <span>
            {shown.length} request{shown.length === 1 ? '' : 's'}
          </span>
          <span className="vcom-meta-actions">
            <select value={typeFilter} onChange={(e) => setTypeFilter(e.target.value as CommercialRequestType | 'all')} aria-label="Type of request">
              <option value="all">All types</option>
              {REQUEST_TYPES.map((x) => (
                <option key={x.key} value={x.key}>{x.label}</option>
              ))}
            </select>
            <button type="button" className="wf-btn wf-btn-ghost wf-btn-sm" onClick={exportCsv} disabled={!shown.length}>
              <Download size={13} /> CSV
            </button>
          </span>
        </div>
        <div className="table-scroll">
          <table className="wide-table">
            <thead>
              <tr>
                <th>Vendor <HeaderInfo label="Vendor" /></th>
                <th>Request <HeaderInfo label="Request" /></th>
                <th>Details <HeaderInfo label="Details" /></th>
                <th>Remarks <HeaderInfo label="Remarks" /></th>
                <th>Files <HeaderInfo label="Files" /></th>
                <th>Status <HeaderInfo label="Status" /></th>
                <th>Requested by <HeaderInfo label="Requested by" /></th>
                <th>Decision <HeaderInfo label="Decision" /></th>
              </tr>
            </thead>
            <tbody>
              {shown.map((r) => (
                <tr key={r.id}>
                  <td>
                    <span className="mono">{r.vendor_code}</span>
                    {r.vendor_name && <small className="wf-subtle"> {r.vendor_name}</small>}
                  </td>
                  <td>{requestTypeLabel(r.request_type, r.business_type)}</td>
                  <td className="wf-subtle">{commercialSummary({ ...r, attachments: [] })}</td>
                  <td>{r.remarks}</td>
                  <td>
                    {r.attachments.length ? (
                      r.attachments.map((a) => (
                        <button key={a.path} type="button" className="wf-chip-btn vcom-open" onClick={() => openFile(r.id, a)} disabled={pending} title={`Open ${a.name}`}>
                          <Paperclip size={11} aria-hidden="true" /> {a.name}
                        </button>
                      ))
                    ) : (
                      <span className="wf-subtle">—</span>
                    )}
                  </td>
                  <td>
                    <StatusBadge status={r.status} edited={r.edited_before_approval} approverEdited={r.approver_edited} />
                    {r.status === 'rejected' && r.rejection_notes && <small className="wf-subtle">{r.rejection_notes}</small>}
                    {r.status === 'rework' && r.rework_notes && <small className="wf-subtle">{r.rework_notes}</small>}
                    {canEdit(role, r.status) && (
                      <button
                        type="button"
                        className="wf-btn wf-btn-ghost wf-btn-sm"
                        onClick={() => startEdit(r)}
                        title={r.status === 'rework' || r.status === 'rejected' ? 'Amend and send back for approval' : 'Amend — it stays in the approval queue'}
                      >
                        <Pencil size={12} /> Edit
                      </button>
                    )}
                  </td>
                  <td className="wf-subtle">
                    {r.requested_by ?? '—'}
                    <small> {fmtDate(r.requested_at)}</small>
                  </td>
                  <td>
                    {canApprove(role, r.status) ? (
                      <ApprovalBar
                        entityType="vendor_commercial"
                        entityId={String(r.id)}
                        entityLabel={`${requestTypeLabel(r.request_type, r.business_type)} — ${r.vendor_code}${r.vendor_name ? ` ${r.vendor_name}` : ''}`}
                        onDone={(result) => {
                          if (result.ok) reloadWithToast(result.message ?? 'Saved.');
                        }}
                      />
                    ) : (
                      <span className="wf-subtle">
                        {r.approved_by ?? '—'}
                        {r.approved_at && <small> {fmtDate(r.approved_at)}</small>}
                      </span>
                    )}
                  </td>
                </tr>
              ))}
              {!shown.length && (
                <tr>
                  <td colSpan={8} className="wf-empty-cell">No commercial approval requests yet.</td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </div>
    </>
  );
}
