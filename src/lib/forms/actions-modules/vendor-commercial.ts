'use server';

import { randomUUID } from 'node:crypto';
import { revalidatePath } from 'next/cache';
import { createAdminClient, hasSupabaseAdminEnv } from '@/lib/supabase/admin';
import { currentUser } from '../queries';
import { canEdit, statusOnSubmit } from '../approval';
import {
  BUSINESS_TYPES,
  COMMERCIAL_BUCKET,
  COST_REASONS,
  REQUEST_TYPES,
  ATTACHMENT_LABEL,
  commercialFileError,
  requestTypeLabel,
  type CommercialAttachment,
  type CommercialBusinessType,
  type CommercialRequestType,
} from '../commercial';
import type { SdStatus } from '../types';
import { type ActionResult, fail, done, supa, writeLog } from './_shared';

const TABLE = 'sd_vendor_commercial_request';
// Paths this module hands out: <vendor>/<uuid>.<ext>. Nothing else is accepted back.
const PATH_RE = /^[A-Za-z0-9_-]{1,40}\/[0-9a-f-]{36}\.[a-z0-9]{1,5}$/;
const safeCode = (code: string) => code.trim().toUpperCase().replace(/[^A-Za-z0-9_-]/g, '_').slice(0, 40) || 'vendor';

const text = (v: FormDataEntryValue | null) => String(v ?? '').trim() || null;
const amount = (v: FormDataEntryValue | null) => {
  const s = String(v ?? '').replace(/[,₹\s]/g, '').replace(/^rs\.?/i, '');
  if (!s) return { ok: true as const, v: null };
  const n = Number(s);
  return Number.isFinite(n) && n >= 0 ? { ok: true as const, v: n } : { ok: false as const };
};
const isoDate = (v: FormDataEntryValue | null) => {
  const s = String(v ?? '').trim();
  return /^\d{4}-\d{2}-\d{2}$/.test(s) ? s : null;
};

type Fields = {
  business_type: CommercialBusinessType;
  vendor_code: string;
  vendor_name: string | null;
  po_numbers: string;
  request_type: CommercialRequestType;
  hold_qty: number | null;
  hold_days: number | null;
  ready_date: string | null;
  hold_reason: string | null;
  cost_reason: string | null;
  cost_reason_other: string | null;
  increment_amount: number | null;
  owner_name: string | null;
  owner_contact: string | null;
  invoice_number: string | null;
  invoice_date: string | null;
  invoice_amount: number | null;
  rg_pending: string | null;
  debit_note_number: string | null;
  credit_amount: number | null;
  remarks: string;
  attachments: CommercialAttachment[];
};

/** The fields of a commercial request, read and checked as the form checks them. */
function commercialFields(formData: FormData): { ok: true; v: Fields } | { ok: false; error: string } {
  const bad = (error: string) => ({ ok: false as const, error });
  const business = String(formData.get('business_type') ?? '') as CommercialBusinessType;
  const type = String(formData.get('request_type') ?? '') as CommercialRequestType;
  const vendorCode = String(formData.get('vendor_code') ?? '').trim().toUpperCase();
  const poNumbers = String(formData.get('po_numbers') ?? '').trim();
  const remarks = String(formData.get('remarks') ?? '').trim();
  if (!BUSINESS_TYPES.some((b) => b.key === business)) return bad('Pick the business type.');
  if (!vendorCode) return bad('Enter the vendor code.');
  if (!text(formData.get('vendor_name'))) return bad('Enter the firm name.');
  if (!poNumbers) return bad('Enter the PO number(s).');
  if (!REQUEST_TYPES.some((r) => r.key === type)) return bad('Pick the type of request.');
  if (!remarks) return bad('Write the reason / remarks.');

  const v: Fields = {
    business_type: business,
    vendor_code: vendorCode,
    vendor_name: text(formData.get('vendor_name')),
    po_numbers: poNumbers.slice(0, 2000),
    request_type: type,
    hold_qty: null,
    hold_days: null,
    ready_date: null,
    hold_reason: null,
    cost_reason: null,
    cost_reason_other: null,
    increment_amount: null,
    owner_name: null,
    owner_contact: null,
    invoice_number: null,
    invoice_date: null,
    invoice_amount: null,
    rg_pending: null,
    debit_note_number: null,
    credit_amount: null,
    remarks: remarks.slice(0, 4000),
    attachments: [],
  };

  if (type === 'hold_waiver') {
    const qty = amount(formData.get('hold_qty'));
    const days = Number(String(formData.get('hold_days') ?? '').trim());
    if (!qty.ok || qty.v == null) return bad('Enter the total hold quantity.');
    if (!Number.isInteger(days) || days < 0 || String(formData.get('hold_days') ?? '').trim() === '') return bad('Enter the total days hold asked by the SAADAA team (a whole number).');
    v.hold_qty = qty.v;
    v.hold_days = days;
    v.ready_date = isoDate(formData.get('ready_date'));
    v.hold_reason = remarks;
  } else if (type === 'cost_increment') {
    const reason = String(formData.get('cost_reason') ?? '');
    if (!COST_REASONS[business].some((r) => r.key === reason)) return bad('Pick the reason for commercial approval.');
    const other = text(formData.get('cost_reason_other'));
    if (reason === 'other' && !other) return bad('Say what the "other" reason is.');
    const inc = amount(formData.get('increment_amount'));
    if (!inc.ok) return bad('The increment amount must be a number.');
    v.cost_reason = reason;
    v.cost_reason_other = reason === 'other' ? other : null;
    v.increment_amount = inc.v;
  } else if (type === 'cash_discount') {
    const amt = amount(formData.get('invoice_amount'));
    if (!amt.ok) return bad('The invoice amount must be a number.');
    v.owner_name = text(formData.get('owner_name'));
    v.owner_contact = text(formData.get('owner_contact'));
    v.invoice_number = text(formData.get('invoice_number'));
    v.invoice_date = isoDate(formData.get('invoice_date'));
    v.invoice_amount = amt.v;
    v.rg_pending = text(formData.get('rg_pending'));
  } else if (type === 'dn_removal') {
    v.debit_note_number = text(formData.get('debit_note_number'));
  } else if (type === 'credit_note') {
    const amt = amount(formData.get('credit_amount'));
    if (!amt.ok) return bad('The credit note amount must be a number.');
    v.credit_amount = amt.v;
  }

  // Files the browser uploaded through startCommercialUpload, kept only where the form takes them.
  let files: CommercialAttachment[] = [];
  try {
    const parsed = JSON.parse(String(formData.get('attachments') ?? '[]')) as CommercialAttachment[];
    files = Array.isArray(parsed) ? parsed : [];
  } catch {
    files = [];
  }
  if (ATTACHMENT_LABEL[type]) {
    for (const f of files) {
      if (!f || typeof f.path !== 'string' || !PATH_RE.test(f.path)) return bad('Attach the files again.');
    }
    v.attachments = files.slice(0, 10).map((f) => ({ path: f.path, name: String(f.name ?? 'file').slice(0, 200), size: Number(f.size) || null }));
  }
  return { ok: true, v };
}

const label = (v: { vendor_code: string; vendor_name: string | null; request_type: CommercialRequestType; business_type: CommercialBusinessType }) =>
  `${requestTypeLabel(v.request_type, v.business_type)} — ${v.vendor_code}${v.vendor_name ? ` ${v.vendor_name}` : ''}`;

/** One-time signed upload URL for an invoice copy / proof file. */
export async function startCommercialUpload(
  vendorCode: string,
  fileName: string,
  size: number,
): Promise<{ ok: true; path: string; token: string } | { ok: false; error: string }> {
  const user = await currentUser();
  if (!user) return { ok: false, error: 'Not signed in.' };
  if (!canEdit(user.role, 'draft')) return { ok: false, error: 'Only team and admin users can attach files.' };
  if (!hasSupabaseAdminEnv()) return { ok: false, error: 'File storage is not configured.' };
  const bad = commercialFileError(String(fileName ?? ''), Number(size));
  if (bad) return { ok: false, error: bad };
  const ext = /\.([A-Za-z0-9]+)$/.exec(String(fileName))?.[1]?.toLowerCase() ?? 'bin';
  const path = `${safeCode(String(vendorCode ?? ''))}/${randomUUID()}.${ext}`;
  const { data, error } = await createAdminClient().storage.from(COMMERCIAL_BUCKET).createSignedUploadUrl(path);
  if (error || !data) return { ok: false, error: 'Could not start the upload — has the commercial-approval migration been applied?' };
  return { ok: true, path: data.path, token: data.token };
}

/** Short-lived link to open an attached file (signed-in SAADAA users; the row must list it). */
export async function signCommercialFile(id: number, path: string): Promise<{ url: string } | { error: string }> {
  const user = await currentUser();
  if (!user) return { error: 'Not signed in.' };
  if (!hasSupabaseAdminEnv()) return { error: 'File storage is not configured.' };
  const supabase = await supa();
  const { data } = await supabase.from(TABLE as never).select('attachments').eq('id', id).maybeSingle();
  const files = ((data as { attachments: CommercialAttachment[] } | null)?.attachments ?? []) as CommercialAttachment[];
  const file = files.find((f) => f.path === path);
  if (!file) return { error: 'File not found on this request.' };
  const { data: signed, error } = await createAdminClient().storage.from(COMMERCIAL_BUCKET).createSignedUrl(file.path, 600, { download: file.name });
  if (error || !signed) return { error: error?.message ?? 'Could not open the file.' };
  return { url: signed.signedUrl };
}

/** Raise a commercial approval request. It goes to the approval queue and always needs an admin. */
export async function createVendorCommercialRequest(formData: FormData): Promise<ActionResult> {
  const user = await currentUser();
  if (!user) return fail('Not signed in.');
  if (!canEdit(user.role, 'draft')) return fail('You do not have permission to raise a commercial approval request.');
  const f = commercialFields(formData);
  if (!f.ok) return fail(f.error);

  const status = statusOnSubmit('vendor_commercial');
  const supabase = await supa();
  const { data, error } = await supabase
    .from(TABLE as never)
    .insert({ ...f.v, status, requested_by: user.email, requested_at: new Date().toISOString() } as never)
    .select('id')
    .single();
  if (error) return fail(/relation|does not exist/i.test(error.message) ? 'Commercial approvals need the database update 20261009180000_vendor_commercial_approval.sql.' : error.message);

  await writeLog('vendor_commercial', String((data as { id: number }).id), label(f.v), 'draft', status, user.email, f.v.remarks);
  revalidatePath('/vendor-commercial');
  revalidatePath('/approvals');
  return done('Commercial approval request submitted for approval.');
}

const FIELD_LABEL: Record<keyof Fields, string> = {
  business_type: 'Business type',
  vendor_code: 'Vendor code',
  vendor_name: 'Firm name',
  po_numbers: 'PO number',
  request_type: 'Type of request',
  hold_qty: 'Hold qty',
  hold_days: 'Days hold asked',
  ready_date: 'Ready date',
  hold_reason: 'Reason for hold',
  cost_reason: 'Reason',
  cost_reason_other: 'Other reason',
  increment_amount: 'Increment amount',
  owner_name: 'Owner name',
  owner_contact: 'Owner contact',
  invoice_number: 'Invoice number',
  invoice_date: 'Invoice date',
  invoice_amount: 'Invoice amount',
  rg_pending: 'RG pending',
  debit_note_number: 'Debit note number',
  credit_amount: 'Credit note amount',
  remarks: 'Remarks',
  attachments: 'Files',
};

/**
 * Amend a commercial request (team / admin). HOUSE RULE: until it is approved, every field can
 * be changed. Sent back or rejected → back to the approval queue; pending stays pending.
 */
export async function updateVendorCommercialRequest(formData: FormData): Promise<ActionResult> {
  const user = await currentUser();
  if (!user) return fail('Not signed in.');
  if (!canEdit(user.role, 'draft')) return fail('You do not have permission to change a commercial approval request.');
  const id = Number(formData.get('id'));
  if (!Number.isInteger(id) || id <= 0) return fail('Invalid request.');
  const f = commercialFields(formData);
  if (!f.ok) return fail(f.error);

  const supabase = await supa();
  const { data: row } = await supabase.from(TABLE as never).select('*').eq('id', id).maybeSingle();
  if (!row) return fail('Request not found.');
  const old = row as unknown as Record<string, unknown>;
  const from = old.status as SdStatus;
  if (from === 'approved') return fail('This request is approved, so it is locked. Ask the approver to reopen it to change it.');

  const same = (k: keyof Fields) =>
    k === 'attachments'
      ? JSON.stringify(old[k] ?? []) === JSON.stringify(f.v[k])
      : typeof f.v[k] === 'number' && old[k] != null
        ? Number(old[k]) === f.v[k]
        : String(old[k] ?? '') === String(f.v[k] ?? '');
  const changes = (Object.keys(f.v) as (keyof Fields)[])
    .filter((k) => !same(k))
    .map((k) => (k === 'attachments' ? 'Files changed' : `${FIELD_LABEL[k]} ${old[k] ?? '—'} → ${f.v[k] ?? '—'}`));
  if (!changes.length) return fail('Nothing was changed.');

  const resubmit = from === 'rework' || from === 'rejected' || from === 'draft';
  const to: SdStatus = resubmit ? statusOnSubmit('vendor_commercial') : from;
  const { data: saved, error } = await supabase
    .from(TABLE as never)
    .update({ ...f.v, status: to } as never)
    .eq('id', id)
    .neq('status', 'approved')
    .select('id')
    .maybeSingle();
  if (error) return fail(error.message);
  if (!saved) return fail('This request was approved meanwhile, so it is locked.');

  // Files taken off the request are deleted from storage (the person confirmed it on screen).
  const kept = new Set(f.v.attachments.map((a) => a.path));
  const dropped = ((old.attachments as CommercialAttachment[] | null) ?? []).filter((a) => !kept.has(a.path)).map((a) => a.path);
  if (dropped.length && hasSupabaseAdminEnv()) await createAdminClient().storage.from(COMMERCIAL_BUCKET).remove(dropped);

  await writeLog('vendor_commercial', String(id), label(f.v), from, to, user.email, `Amended: ${changes.join('; ')}${resubmit ? ' — resubmitted for approval' : ''}`);
  revalidatePath('/vendor-commercial');
  revalidatePath('/approvals');
  return done(`Commercial approval request saved${resubmit ? ' and sent back for approval' : ''}.`);
}
