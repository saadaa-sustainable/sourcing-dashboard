'use client';

import { useMemo, useRef, useState, useTransition } from 'react';
import { BadgeIndianRupee, Download, Paperclip, X } from 'lucide-react';
import { isCommercialPoEligible } from '@/lib/commercial-po-eligibility';
import { Combobox } from '@/components/forms/combobox';
import { HeaderInfo } from '@/components/header-info';
import { Field, Notice, StatusBadge } from '@/components/forms/form-layout';
import { CommercialAccounts } from './commercial-review';
import { COMMERCIAL_EXTRA_FIELDS, commercialImpact, commercialRequestNumber, fabricConsumptionIncrease, holdWaiverDays, grnDelayDays, type CommercialDetails } from '@/lib/forms/commercial-workflow';
import type { CommercialActor, CommercialPo } from '@/lib/commercial-access.server';
import type { CommercialEvent, CommercialAccount } from '@/lib/forms/queries-modules/vendor-commercial';
import { createClient } from '@/lib/supabase/client';
import { downloadCsv } from '@/lib/download';
import { browserUuid } from '@/lib/browser-uuid';
import { confirmDelete } from '@/lib/confirm';
import { reloadWithToast, toastError, flashToast } from '@/lib/toast';
import { canEdit } from '@/lib/forms/approval';
import {
  createVendorCommercialRequest,
  startCommercialUpload,
  updateVendorCommercialRequest,
  loadCommercialPos,
} from '@/lib/forms/actions-modules/vendor-commercial';
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
function matchesRequestStatus(request: VendorCommercialRequest, filter: string) {
  if (filter === 'all') return true;
  if (filter === 'pending_l2') return ['pending_l2', 'submitted'].includes(request.status);
  if (filter === 'needs_resubmission') return ['rework', 'rejected'].includes(request.status);
  if (filter === 'pending_finance') return request.status === 'approved' && request.processing_status !== 'processed';
  if (filter === 'processed') return request.processing_status === 'processed';
  return request.status === filter;
}
const requestForm = (request?: VendorCommercialRequest): Form => request
  ? Object.fromEntries(Object.keys(EMPTY).map((key) => [key, s(request[key as keyof VendorCommercialRequest])])) as Form
  : { ...EMPTY };

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
  role, actor, events = [], accounts = [], initialPos = [], editRequest,
}: {
  requests: VendorCommercialRequest[];
  vendors: { vendor_code: string; vendor_name: string | null; primary_type: string | null }[];
  role: SdRole;
  actor: CommercialActor;
  events?: CommercialEvent[];
  accounts?: CommercialAccount[];
  initialPos?: CommercialPo[];
  editRequest?: VendorCommercialRequest;
}) {
  const editable = !!actor.vendorCode || canEdit(role, 'draft');
  const basePath = actor.vendorCode ? '/commercial-requests' : '/vendor-commercial';
  const [form, setForm] = useState<Form>(editRequest ? requestForm(editRequest) : { ...EMPTY, vendor_code: actor.vendorCode ?? '', vendor_name: actor.vendorName ?? '' });
  const [details, setDetails] = useState<CommercialDetails>(editRequest?.details ?? {});
  const [revision, setRevision] = useState(editRequest?.revision ?? 0);
  const [submissionKey, setSubmissionKey] = useState<string | null>(null);
  const [pos, setPos] = useState(initialPos);
  const selectedVendor = useRef(actor.vendorCode ?? '');
  const [page, setPage] = useState(1);
  const [search, setSearch] = useState('');
  const [statusFilter, setStatusFilter] = useState('all');
  const listHeading = useRef<HTMLHeadingElement>(null);
  const [kept, setKept] = useState<CommercialAttachment[]>(editRequest?.attachments ?? []);
  const [files, setFiles] = useState<File[]>([]);
  const [editingId, setEditingId] = useState<number | null>(editRequest?.id ?? null);
  const [error, setError] = useState<string | null>(null);
  const [typeFilter, setTypeFilter] = useState<CommercialRequestType | 'all'>('all');
  const [pending, start] = useTransition();
  const set = <K extends keyof Form>(k: K, v: Form[K]) => setForm((f) => ({ ...f, [k]: v }));
  const byCode = useMemo(() => new Map(vendors.map((v) => [v.vendor_code, v])), [vendors]);
  const b = form.business_type || null;
  const t = form.request_type || null;
  const takesFiles = t ? Boolean(ATTACHMENT_LABEL[t]) : false;
  const eligiblePos = pos.filter((po) => po.vendor_code === form.vendor_code.trim().toUpperCase() && isCommercialPoEligible(po));

  function pickVendor(code: string) {
    const up = code.trim().toUpperCase();
    selectedVendor.current = up;
    const v = byCode.get(up);
    setForm((f) => ({ ...f, vendor_code: up, vendor_name: v?.vendor_name ?? '', po_numbers: '' }));
    setPos([]);
    start(async () => {
      try { const rows = await loadCommercialPos(up); if (selectedVendor.current === up) setPos(rows); }
      catch { setError('Could not load purchase orders. Try selecting the vendor again.'); }
    });
  }

  function reset() {
    selectedVendor.current = actor.vendorCode ?? '';
    setForm({ ...EMPTY, vendor_code: actor.vendorCode ?? '', vendor_name: actor.vendorName ?? '' });
    setDetails({});
    setSubmissionKey(null);
    setRevision(0);
    setKept([]);
    setFiles([]);
    setEditingId(null);
    setError(null);
  }

  async function dropKept(a: CommercialAttachment) {
    const ok = await confirmDelete({
      title: `Remove ${a.name}?`,
      body: 'The file is removed from the current request when you save. Previous revisions retain it for audit.',
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
    (t === 'hold_waiver' || t === 'grn_delay_waiver' || t === 'surplus_fabric_consumption' || !!form.remarks.trim()) &&
    (t !== 'hold_waiver' || (form.hold_qty.trim() !== '' && form.hold_days.trim() !== '' && !!form.ready_date && COMMERCIAL_EXTRA_FIELDS.hold_waiver.every((field) => !field.required || !!details[field.key]?.trim()) && kept.length + files.length > 0)) &&
    (t !== 'cost_increment' || (!!form.cost_reason && !!form.increment_amount.trim() && Number.isFinite(Number(form.increment_amount)) && Number(form.increment_amount) > 0 && (!form.cost_reason.split(',').includes('other') || !!form.cost_reason_other.trim()))) &&
    (t !== 'cash_discount' || [form.owner_name, form.owner_contact, form.invoice_number, form.invoice_date, form.rg_pending].every((value) => !!value.trim())) &&
    (t !== 'dn_removal' || (!!form.debit_note_number.trim() && kept.length + files.length > 0)) &&
    (t !== 'grn_delay_waiver' || COMMERCIAL_EXTRA_FIELDS.grn_delay_waiver.every((field) => field.readOnly || !!details[field.key]?.trim())) &&
    (t !== 'surplus_fabric_consumption' || (!!details.initial_consumption?.trim() && !!details.revised_consumption?.trim() && kept.length + files.length > 0));

  function submit(intent: 'draft' | 'submit' = 'submit') {
    setError(null);
    start(async () => {
      try {
      const key = submissionKey ?? browserUuid();
      setSubmissionKey(key);
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
      fd.set('intent', intent);
      fd.set('revision', String(revision));
      fd.set('submission_key', key);
      fd.set('details', JSON.stringify(details));
      fd.set('attachments', JSON.stringify(takesFiles ? [...kept, ...uploaded] : []));
      if (editingId != null) fd.set('id', String(editingId));
      const r = editingId != null ? await updateVendorCommercialRequest(fd) : await createVendorCommercialRequest(fd);
      if (r.ok) {
        if (editRequest) { flashToast(r.message ?? 'Request saved.'); window.location.assign(basePath); return; }
        reset();
        reloadWithToast(r.message);
      } else setError(toastError(r.error));
      } catch { setError('Could not save the request. Check your connection and try again.'); }
    });
  }


  const shown = requests.filter((r) => (typeFilter === 'all' || r.request_type === typeFilter)
    && matchesRequestStatus(r, statusFilter)
    && (!search || `${commercialRequestNumber(r.id, r.requested_at)} ${r.vendor_code} ${r.vendor_name} ${r.po_numbers} ${r.invoice_number ?? ''} ${r.debit_note_number ?? ''}`.toLowerCase().includes(search.toLowerCase())));

  const currentPage = Math.min(page, Math.max(1, Math.ceil(shown.length / 25)));
  const pageRows = shown.slice((currentPage - 1) * 25, currentPage * 25);

  function exportCsv() {
    downloadCsv(
      'vendor-commercial-approvals',
      ['Request ID', 'Requested amount', 'Approved amount', 'Processing status', 'Processed reference', 'Raised', 'Raised by', 'Business type', 'Vendor code', 'Firm', 'PO number', 'Type of request', 'Details', 'Remarks', 'Files', 'Status', 'Decided by', 'Decided on', 'Decision remarks', 'Waiver days', 'Approved waiver days'],
      shown.map((r) => [
        commercialRequestNumber(r.id, r.requested_at), commercialImpact(r.request_type, r.details ?? {}, r.increment_amount, r.invoice_amount, r.credit_amount), r.request_type === 'hold_waiver' ? null : r.approved_amount, r.processing_status, r.processed_reference, r.requested_at, r.requested_by, BUSINESS_TYPES.find((x) => x.key === r.business_type)?.label ?? r.business_type, r.vendor_code, r.vendor_name, r.po_numbers,
        requestTypeLabel(r.request_type, r.business_type), commercialSummary(r), r.remarks, r.attachments.map((a) => a.name).join('; '),
        r.status, r.approved_by, r.approved_at, r.rejection_notes || r.rework_notes,
        r.request_type === 'hold_waiver' ? holdWaiverDays(r.details ?? {}) : null, r.request_type === 'hold_waiver' ? r.details?.approved_waiver_days ?? null : null,
      ]),
    );
  }

  return (
    <div className="commercial-workspace">
      {editRequest && <a className="wf-btn wf-btn-ghost" href={basePath}>Back to requests</a>}
      {!editRequest && <>
      <div className="commercial-metrics">
        {[
          ['all', 'Total requests'], ['pending_l2', 'Approval Pending'],
          ['needs_resubmission', 'Needs resubmission'], ['pending_finance', 'Pending Finance action'], ['processed', 'Processed'],
        ].map(([filter, label]) => <button type="button" key={filter} aria-pressed={statusFilter === filter && !search && typeFilter === 'all'} aria-controls="commercial-requests-table" onClick={() => {
          setStatusFilter(filter); setSearch(''); setTypeFilter('all'); setPage(1);
          listHeading.current?.focus({ preventScroll: true });
          listHeading.current?.scrollIntoView({ behavior: window.matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth', block: 'start' });
        }}><strong>{requests.filter((request) => matchesRequestStatus(request, filter)).length}</strong><span>{label}</span></button>)}
      </div>

      </>}
      {error && <Notice tone="error">{error}</Notice>}

      {editable && (
        <details open={!!editRequest} className="panel wf-form-panel commercial-request-form">
          <summary className="panel-title commercial-request-toggle">
            <h3>{editingId != null ? `Amend request #${editingId}` : 'Raise a commercial approval request'}</h3>
          </summary>

          <div className="wf-form-grid commercial-request-basics">
            <Field label="Business type" required={t === 'cash_discount'}>
              <select value={form.business_type} onChange={(e) => setForm((f) => ({ ...f, business_type: e.target.value as CommercialBusinessType | '', cost_reason: '', cost_reason_other: '' }))}>
                <option value="">Select…</option>
                {BUSINESS_TYPES.map((x) => (
                  <option key={x.key} value={x.key}>{x.label} ({x.hint})</option>
                ))}
              </select>
            </Field>
            <Field label="Vendor code" required={t === 'cash_discount'} hint="Verified against the vendor master" hintPlacement="below">
              <input disabled={!!actor.vendorCode} list="vc-vendors" value={form.vendor_code} onChange={(e) => pickVendor(e.target.value)} placeholder="e.g. KVN" />
              <datalist id="vc-vendors">
                {vendors.map((v) => (
                  <option key={v.vendor_code} value={v.vendor_code}>{v.vendor_name ?? ''}</option>
                ))}
              </datalist>
            </Field>
            <Field label="Firm name" required={t === 'cash_discount'}>
              <input value={form.vendor_name} readOnly />
            </Field>
            <Field label="Purchase order" required={t === 'cash_discount'} hint="This vendor’s Approved and Completed POs created from 1 April 2026; FG-closed POs excluded" hintPlacement="below">
              <div className="commercial-po-picker">
                <Combobox
                  ariaLabel="Purchase order"
                  value={form.po_numbers}
                  onChange={(value) => set('po_numbers', value)}
                  options={[
                    { value: '', label: 'Clear purchase order selection' },
                    ...eligiblePos.map((po) => ({ value: po.po_ref_num, label: po.po_ref_num, detail: po.po_status ?? undefined })),
                  ]}
                  allowFreeText={false}
                  required={t === 'cash_discount'}
                  disabled={pending || !form.vendor_code.trim()}
                  placeholder="Search purchase order..."
                  emptyText="No matching eligible purchase orders."
                />
                {form.po_numbers && !eligiblePos.some((po) => po.po_ref_num === form.po_numbers) && <small className="wf-error-text">The saved PO is outside the current selection list. Choose a newer PO if changing it.</small>}
              </div>
            </Field>
            <Field label="Type of request" required={t === 'cash_discount'}>
              <select aria-label="Commercial request type" value={form.request_type} onChange={(e) => { set('request_type', e.target.value as CommercialRequestType | ''); setDetails({}); }}>
                <option value="">Select…</option>
                {REQUEST_TYPES.map((x) => (
                  <option key={x.key} value={x.key} disabled={x.key === 'credit_note'}>{requestTypeLabel(x.key, b)}{x.key === 'credit_note' ? ' (Coming soon)' : ''}</option>
                ))}
              </select>
            </Field>
          </div>

          {t && <div className="commercial-request-section-heading">
            <h4>Request for {requestTypeLabel(t, b)}</h4>
            {t === 'surplus_fabric_consumption' && <p className="commercial-grn-disclaimer">This can be raised only if the increase in average fabric consumption is greater than 1% of the initial average fabric consumption.</p>}
            {t === 'grn_delay_waiver' && <p className="commercial-grn-disclaimer">This request is for GRNs delayed by the warehouse team. It can be raised only when the GRN date is more than 7 days after the goods delivery date.</p>}
          </div>}

          {t === 'hold_waiver' && (
            <div className="wf-form-grid">
              <Field label="Total hold qty" required>
                <input type="number" min={0} value={form.hold_qty} onChange={(e) => set('hold_qty', e.target.value)} />
              </Field>
              <Field label="Total days hold asked by the SAADAA team" required>
                <input type="number" min={0} step={1} value={form.hold_days} onChange={(e) => set('hold_days', e.target.value)} />
              </Field>
              <Field label={`${b === 'fabric' ? 'Fabric' : 'Goods'} ready date`} required>
                <input type="date" value={form.ready_date} onChange={(e) => set('ready_date', e.target.value)} />
              </Field>
            </div>
          )}

          {t === 'cost_increment' && (
            <Field label="Mention rate (increased amount you are requesting for)" required>
              <input inputMode="decimal" value={form.increment_amount} onChange={(e) => set('increment_amount', e.target.value)} />
            </Field>
          )}

          {t === 'cost_increment' && (
            <div className="wf-form-grid">
              <fieldset className="field wf-field"><legend>Reason for commercial approval <em className="wf-required-mark" aria-label="required">*</em></legend>
                <div>{(b ? COST_REASONS[b] : []).map((reason) => <div key={reason.key}><label style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
                  <input type="checkbox" disabled={!b} checked={form.cost_reason.split(',').includes(reason.key)} onChange={(e) => {
                    const selected = form.cost_reason.split(',').filter(Boolean).filter((key) => key !== reason.key);
                    if (e.target.checked) selected.push(reason.key);
                    set('cost_reason', selected.join(','));
                  }} />{reason.label}
                </label>
                {reason.key === 'other' && form.cost_reason.split(',').includes('other') && <div className="commercial-other-reason"><Field label="Write the reason" required>
                  <input value={form.cost_reason_other} onChange={(e) => set('cost_reason_other', e.target.value)} placeholder="Enter the reason for commercial approval" maxLength={2000} />
                </Field></div>}
                </div>)}</div>
              </fieldset>
            </div>
          )}

          {t === 'cash_discount' && (
            <div className="wf-form-grid">
              <Field label="Owner name" required>
                <input value={form.owner_name} onChange={(e) => set('owner_name', e.target.value)} />
              </Field>
              <Field label="Owner contact number" required>
                <input inputMode="tel" value={form.owner_contact} onChange={(e) => set('owner_contact', e.target.value)} />
              </Field>
              <Field label="Invoice number" required>
                <input value={form.invoice_number} onChange={(e) => set('invoice_number', e.target.value)} />
              </Field>
              <Field label="Invoice date" required>
                <input type="date" value={form.invoice_date} onChange={(e) => set('invoice_date', e.target.value)} />
              </Field>
              <Field label="Invoice amount (₹)">
                <input inputMode="decimal" value={form.invoice_amount} onChange={(e) => set('invoice_amount', e.target.value)} />
              </Field>
              <Field label="RG pending with vendor" required>
                <input value={form.rg_pending} onChange={(e) => set('rg_pending', e.target.value)} />
              </Field>
            </div>
          )}

          {t === 'dn_removal' && (
            <div className="wf-form-grid">
              <Field label="Debit note number" required>
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

          {t && t !== 'cost_increment' && t !== 'cash_discount' && <div className="wf-form-grid">
            {COMMERCIAL_EXTRA_FIELDS[t].filter((field) => t !== 'hold_waiver' || field.key !== 'requested_amount').map((field) => <Field key={field.key} label={field.label} required={field.required}>
              {field.readOnly ? <input readOnly value={field.key === 'grn_delay_days' ? grnDelayDays(details) ?? '' : field.key === 'consumption_increase_percent' ? fabricConsumptionIncrease(details.initial_consumption ?? '', details.revised_consumption ?? '')?.percent ?? '' : fabricConsumptionIncrease(details.initial_consumption ?? '', details.revised_consumption ?? '')?.amount ?? ''} /> : field.options ? <select value={details[field.key] ?? ''} onChange={(e) => setDetails((d) => ({ ...d, [field.key]: e.target.value }))}>
                <option value="">Select…</option>{field.options.map((option) => <option key={option}>{option}</option>)}
              </select> : <input type={field.type ?? 'text'} min={field.type === 'number' ? 0 : undefined} step={field.type === 'number' ? 'any' : undefined} value={details[field.key] ?? ''} onChange={(e) => setDetails((d) => ({ ...d, [field.key]: e.target.value }))} />}
            </Field>)}
            {t === 'hold_waiver' && <Field label="Waiver days" hint="Hold end date minus hold start date" hintPlacement="below"><input aria-label="Waiver days" readOnly value={holdWaiverDays(details) ?? ''} /></Field>}
            {commercialImpact(t, details, form.increment_amount === '' ? null : Number(form.increment_amount), form.invoice_amount === '' ? null : Number(form.invoice_amount), form.credit_amount === '' ? null : Number(form.credit_amount)) != null && <p>Requested impact: INR {commercialImpact(t, details, Number(form.increment_amount), Number(form.invoice_amount), Number(form.credit_amount))?.toLocaleString('en-IN')}</p>}
          </div>}

          {t && t !== 'grn_delay_waiver' && (
            <>
              {t !== 'surplus_fabric_consumption' && <Field label={REMARKS_LABEL[t]} required={t === 'cash_discount' || t === 'dn_removal' || t === 'cost_increment'} hint={t === 'cost_increment' ? 'Explain why the rate increase is needed. Include the affected fabric or process, the current rate, and any supporting context for approval.' : t === 'cash_discount' ? 'Explain the cash discount request and include any relevant payment or invoice details for approval.' : undefined} hintPlacement="below">
                <textarea aria-label={REMARKS_LABEL[t]} className="wf-textarea" rows={3} value={form.remarks} onChange={(e) => set('remarks', e.target.value)} />
              </Field>}
              {takesFiles && t !== 'cost_increment' && (
                <div className="vcom-files">
                  <span className="vcom-files-label">{ATTACHMENT_LABEL[t]}{(t === 'hold_waiver' || t === 'dn_removal' || t === 'surplus_fabric_consumption') && <em className="wf-required-mark" aria-label="required"> *</em>}</span>
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
              <a className="wf-btn wf-btn-ghost" href={basePath}>Cancel</a>
            )}
            {(editingId == null || requests.find((r) => r.id === editingId)?.status === 'draft') && <button type="button" className="wf-btn wf-btn-ghost" disabled={pending || !form.business_type || !form.vendor_code || !form.po_numbers || !t} onClick={() => submit('draft')}>Save draft</button>}
            <button type="button" className="wf-btn wf-btn-primary" onClick={() => submit('submit')} disabled={pending || !canSend}>
              <BadgeIndianRupee size={15} /> {pending ? 'Saving…' : editingId != null && requests.find((r) => r.id === editingId)?.status !== 'draft' ? 'Save and resubmit' : 'Submit for approval'}
            </button>
          </div>
        </details>
      )}

      {!editRequest && <div className="table-panel commercial-request-list">
        <h3 ref={listHeading} tabIndex={-1} className="commercial-request-list-title">Commercial Approval Requests</h3>
        <div className="table-meta">
          <span>
            {shown.length} request{shown.length === 1 ? '' : 's'}
          </span>
          <span className="vcom-meta-actions">
            <input aria-label="Search commercial requests" placeholder="Search request, vendor, PO, invoice…" value={search} onChange={(e) => { setSearch(e.target.value); setPage(1); }} />
            <select aria-label="Request status" value={statusFilter} onChange={(e) => { setStatusFilter(e.target.value); setPage(1); }}>
              <option value="all">All statuses</option><option value="draft">Draft</option><option value="pending_l2">Approval Pending</option><option value="approved">Approved</option><option value="rework">Rework</option><option value="rejected">Rejected</option>
              <option value="needs_resubmission">Needs resubmission</option><option value="pending_finance">Pending Finance action</option><option value="processed">Processed</option>
            </select>
            <select value={typeFilter} onChange={(e) => { setTypeFilter(e.target.value as CommercialRequestType | 'all'); setPage(1); }} aria-label="Filter request type">
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
          <table id="commercial-requests-table" className="wide-table">
            <thead>
              <tr>
                <th>Request <HeaderInfo label="Request" /></th>
                <th>Request Date <HeaderInfo label="Request Date" /></th>
                <th>Vendor <HeaderInfo label="Vendor" /></th>
                <th>Purchase Order <HeaderInfo label="Purchase Order" /></th>
                <th>Status <HeaderInfo label="Status" /></th>
                <th>Decision <HeaderInfo label="Decision" /></th>
              </tr>
            </thead>
            <tbody>
              {pageRows.map((r) => (
                <tr key={r.id}>
                  <td><strong>{commercialRequestNumber(r.id, r.requested_at)}</strong><br />{requestTypeLabel(r.request_type, r.business_type)}<small className="wf-subtle">Revision {r.revision}</small></td>
                  <td className="commercial-request-date">{fmtDate(r.requested_at)}
                    {['pending_l2', 'submitted'].includes(r.status) && <small>Pending {Math.max(0, Math.floor((Date.now() - Date.parse(r.submitted_at ?? r.requested_at ?? new Date().toISOString())) / 86400000))} days</small>}
                  </td>
                  <td>
                    <span className="mono">{r.vendor_code}</span>
                    {r.vendor_name && <small className="wf-subtle"> {r.vendor_name}</small>}
                  </td>
                  <td className="commercial-po-number">{r.po_numbers}</td>
                  <td className="commercial-status-cell" data-status={r.status}>
                    <StatusBadge status={r.status} edited={r.edited_before_approval} approverEdited={r.approver_edited} />
                    {r.status === 'rejected' && r.rejection_notes && <small className="wf-subtle">{r.rejection_notes}</small>}
                    {r.status === 'rework' && r.rework_notes && <small className="wf-subtle">{r.rework_notes}</small>}
                  </td>
                  <td>
                    <a className="wf-btn wf-btn-ghost wf-btn-sm" href={`${basePath}/${r.id}/review`}>{role === 'admin' ? 'Review request' : 'View details / history'}</a>
                  </td>
                </tr>
              ))}
              {!shown.length && (
                <tr>
                  <td colSpan={6} className="wf-empty-cell">No commercial approval requests yet.</td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
        <div className="commercial-pagination"><span>Page {currentPage} of {Math.max(1, Math.ceil(shown.length / 25))}</span><div><button className="wf-btn wf-btn-ghost" disabled={currentPage <= 1} onClick={() => setPage(currentPage - 1)}>Previous</button><button className="wf-btn wf-btn-ghost" disabled={currentPage * 25 >= shown.length} onClick={() => setPage(currentPage + 1)}>Next</button></div></div>
      </div>}
      {!editRequest && role === 'admin' && <CommercialAccounts accounts={accounts} vendors={vendors} />}
      {!editRequest && <>
      <details className="panel commercial-updates"><summary>Recent updates</summary>
        {[...events].reverse().filter((event) => event.actor_email !== actor.email).slice(0, 5).map((event) => <p key={event.id}>
          <strong>{commercialRequestNumber(event.request_id, String(event.after_values.requested_at ?? ''))}</strong>{' · '}
          {String(event.after_values.processing_status) === 'processed' ? 'Processed by Finance' : ({ pending_l2: 'Awaiting approval', submitted: 'Awaiting approval', approved: 'Approved', rework: 'Sent for rework', rejected: 'Rejected', draft: 'Draft updated' } as Record<string, string>)[String(event.after_values.status)] ?? 'Updated'}{' · '}
          {new Date(event.occurred_at).toLocaleString('en-IN', { timeZone: 'Asia/Kolkata' })} IST
        </p>)}
        {!events.some((event) => event.actor_email !== actor.email) && <p>No new updates from other participants.</p>}
      </details>
      </>}
    </div>
  );
}
