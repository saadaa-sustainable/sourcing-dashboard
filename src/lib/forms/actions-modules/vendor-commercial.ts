'use server';

import { randomUUID } from 'node:crypto';
import { revalidatePath } from 'next/cache';
import { createAdminClient } from '@/lib/supabase/admin';
import { commercialActor, commercialPos } from '@/lib/commercial-access.server';
import { mayEditCommercial, commercialImpact, holdWaiverDays, grnDelayDays, fabricConsumptionIncrease } from '../commercial-workflow';
import { commercialFields, safeCode } from '../commercial-validation';
import { statusOnSubmit } from '../approval';
import { COMMERCIAL_BUCKET, commercialFileError, type CommercialAttachment } from '../commercial';
import { type ActionResult, fail, done } from './_shared';

const parseAmount = (raw: FormDataEntryValue | null) => {
  const value = String(raw ?? '').trim();
  const n = Number(value);
  return value && Number.isFinite(n) && n >= 0 ? { ok: true, v: n } : { ok: !value, v: null };
};

const TABLE = 'sd_vendor_commercial_request';
/** Every entry point resolves a real cookie session; browser roles cannot write the tables. */
export async function startCommercialUpload(vendorCode: string, fileName: string, size: number): Promise<{ ok: true; path: string; token: string } | { ok: false; error: string }> {
  const actor = await commercialActor();
  if (!actor || (!actor.vendorCode && actor.role === 'viewer')) return { ok: false, error: 'Commercial access required.' };
  if (actor.vendorCode && actor.vendorCode !== vendorCode) return { ok: false, error: 'Vendor mismatch.' };
  const bad = commercialFileError(String(fileName), Number(size));
  if (bad) return { ok: false, error: bad };
  const ext = /\.([A-Za-z0-9]+)$/.exec(fileName)?.[1]?.toLowerCase();
  // A separate upload ticket binds every attachment to its uploader, not just vendor code.
  const path = `${safeCode(vendorCode)}/${randomUUID()}.${ext}`;
  const db = createAdminClient();
  const { data, error } = await db.storage.from(COMMERCIAL_BUCKET).createSignedUploadUrl(path);
  if (error || !data) return { ok: false, error: 'Could not start upload.' };
  const ticket = await db.from('sd_commercial_upload' as never).insert({ path, uploaded_by: actor.email } as never);
  if (ticket.error) return { ok: false, error: 'Could not register upload.' };
  return { ok: true, path: data.path, token: data.token };
}

export async function signCommercialFile(id: number, path: string): Promise<{ url: string } | { error: string }> {
  const actor = await commercialActor();
  if (!actor) return { error: 'Commercial access required.' };
  const db = createAdminClient();
  const { data } = await db.from(TABLE as never).select('*').eq('id', id).maybeSingle();
  const row = data as unknown as import('../types').VendorCommercialRequest | null;
  if (!row || (actor.vendorCode && actor.vendorCode !== row.vendor_code)) return { error: 'Request not found.' };
  const file = row.attachments.find((f) => f.path === path);
  if (!file) return { error: 'File not found on this request.' };
  const { data: signed, error } = await db.storage.from(COMMERCIAL_BUCKET).createSignedUrl(path, 600, { download: file.name });
  return error || !signed ? { error: 'Could not open file.' } : { url: signed.signedUrl };
}

export async function loadCommercialPos(vendorCode: string) {
  const actor = await commercialActor();
  if (!actor || (actor.vendorCode && actor.vendorCode !== vendorCode)) return [];
  return commercialPos(vendorCode);
}

async function saveRequest(formData: FormData, editing: boolean): Promise<ActionResult> {
  const actor = await commercialActor();
  if (!actor || (!actor.vendorCode && actor.role === 'viewer')) return fail('Commercial write access required.');
  const db = createAdminClient();
  const id = Number(formData.get('id'));
  const revision = Number(formData.get('revision'));
  const { data: existing, error: readError } = editing
    ? await db.from(TABLE as never).select('*').eq('id', id).maybeSingle()
    : { data: null, error: null };
  if (readError) return fail(readError.message);
  const old = existing as unknown as import('../types').VendorCommercialRequest | null;
  if (editing && (!old || !mayEditCommercial(actor.email, actor.role === 'admin', old.requested_by, old.status) || (actor.vendorCode && actor.vendorCode !== old.vendor_code))) return fail('Only the owner or admin can amend an unapproved request.');
  if (formData.get('request_type') === 'credit_note' && old?.request_type !== 'credit_note') return fail('Credit note requests are not available yet.');
  const draft = formData.get('intent') === 'draft' && (!old || old.status === 'draft');
  if (actor.vendorCode) {
    formData.set('vendor_code', actor.vendorCode);
    formData.set('vendor_name', actor.vendorName ?? actor.vendorCode);
  }
  const f = commercialFields(formData, draft);
  if (!f.ok) return fail(f.error);
  // Canonical vendor name and a real vendor-owned PO, even for internal submissions.
  const { data: vendor } = await db.from('vendor_master_data').select('vendor_name,is_active').eq('vendor_code', f.v.vendor_code).maybeSingle();
  if (!vendor?.is_active) return fail('Choose an active vendor from the master.');
  f.v.vendor_name = vendor.vendor_name;
  const pos = await commercialPos(f.v.vendor_code);
  if (!pos.some((p) => p.po_ref_num === f.v.po_numbers)) return fail('Choose an Approved or Completed purchase order belonging to this vendor.');
  const kept = new Set((old?.attachments ?? []).map((a) => a.path));
  for (const file of f.v.attachments) {
    if (kept.has(file.path)) continue;
    const { data: ticket } = await db.from('sd_commercial_upload' as never).select('path').eq('path', file.path).eq('uploaded_by', actor.email).maybeSingle();
    if (!ticket) return fail('Attach files uploaded by your account.');
    const { data: objects, error } = await db.storage.from(COMMERCIAL_BUCKET).list(safeCode(f.v.vendor_code), { search: file.path.split('/')[1], limit: 2 });
    if (error || !objects?.some((o) => o.name === file.path.split('/')[1])) return fail('An attachment upload is incomplete. Upload it again.');
  }
  if (!draft && (f.v.invoice_number || f.v.debit_note_number)) {
    const key = f.v.request_type === 'dn_removal' ? 'debit_note_number' : 'invoice_number';
    const value = f.v[key];
    if (value) {
      let query = db.from(TABLE as never).select('id', { count: 'exact', head: true }).eq('vendor_code', f.v.vendor_code).eq('po_numbers', f.v.po_numbers).eq('request_type', f.v.request_type).eq(key, value).neq('status', 'rejected');
      if (editing) query = query.neq('id', id);
      const { count, error } = await query;
      if (error) return fail(error.message);
      if (count) return fail('A request already exists for this PO and invoice / debit note. Review the existing request first.');
    }
  }
  const status = draft ? 'draft' : statusOnSubmit('vendor_commercial');
  const patch = { ...f.v, status, last_actor: actor.email, ...(!draft ? { submitted_at: new Date().toISOString() } : {}), ...(old && old.status !== 'draft' ? { edited_before_approval: true } : {}) };
  if (editing) {
    const { data, error } = await db.from(TABLE as never).update(patch as never).eq('id', id).eq('revision', revision).neq('status', 'approved').select('id').maybeSingle();
    if (error) return fail(error.message);
    if (!data) return fail('This request changed. Refresh and review it before saving.');
  } else {
    const key = String(formData.get('submission_key') ?? '');
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(key)) return fail('Invalid submission key. Refresh and try again.');
    const { error } = await db.from(TABLE as never).insert({ ...patch, submission_key: key, requested_by: actor.email, requested_at: new Date().toISOString() } as never);
    if (error?.code === '23505') return fail('This submission was already saved. Refresh to see it.');
    if (error) return fail(error.message);
  }
  if (!draft) await commercialNotice({ title: `Commercial request: ${f.v.vendor_code} / ${f.v.po_numbers}`, body: 'A vendor commercial request is awaiting review.', audience_role: 'admin', created_by: actor.email, link: '/vendor-commercial' });
  refreshCommercial();
  return done(draft ? 'Draft saved.' : 'Request saved and submitted for admin approval.');
}
export async function createVendorCommercialRequest(formData: FormData) { return saveRequest(formData, false); }
export async function updateVendorCommercialRequest(formData: FormData) { return saveRequest(formData, true); }

function refreshCommercial() {
  revalidatePath('/vendor-commercial');
  revalidatePath('/commercial-requests');
  revalidatePath('/approvals');
}

async function commercialNotice(notice: Record<string, unknown>) {
  // In-app only; decision history remains transactional even if this optional bell notice fails.
  try { await createAdminClient().from('sd_notification').insert({ kind: 'vendor_commercial', ...notice } as never); }
  catch { /* The committed request and its audit event remain the source of truth. */ }
}

export async function decideCommercialRequest(formData: FormData): Promise<ActionResult> {
  const actor = await commercialActor();
  if (!actor || actor.vendorCode || actor.role !== 'admin') return fail('Admin approval required.');
  const id = Number(formData.get('id'));
  const revision = Number(formData.get('revision'));
  const decision = String(formData.get('decision'));
  const notes = String(formData.get('notes') ?? '').trim();
  if (!['approve', 'reject', 'rework', 'reopen', 'process'].includes(decision)) return fail('Invalid decision.');
  if (decision !== 'approve' && !notes) return fail('Enter a decision reason / processing note.');
  const db = createAdminClient();
  const { data } = await db.from(TABLE as never).select('*').eq('id', id).maybeSingle();
  const row = data as unknown as import('../types').VendorCommercialRequest | null;
  if (!row || row.revision !== revision) return fail('Request changed. Refresh and review the latest revision.');
  if (decision !== 'process' && actor.email === row.requested_by) return fail('A different admin must review your request.');
  const now = new Date().toISOString();
  const patch: Record<string, unknown> = { last_actor: actor.email, decision_notes: notes };
  if (decision === 'process') {
    if (row.status !== 'approved' || row.processing_status === 'processed') return fail('Only an approved, unprocessed request can be processed.');
    const value = parseAmount(formData.get('processed_amount'));
    const reference = String(formData.get('processed_reference') ?? '').trim();
    if (row.request_type === 'hold_waiver') {
      if (row.details?.approved_waiver_days == null) return fail('Reopen and approve this waiver in days before marking it completed.');
      if (!reference) return fail('Enter the waiver completion reference.');
      delete patch.decision_notes;
      Object.assign(patch, { processing_status: 'processed', processed_amount: null, processed_reference: `${reference} — ${notes}`, processed_at: now, processed_by: actor.email });
    } else {
    if (!value.ok || value.v == null || !reference) return fail('Enter the processed amount and document / payment reference.');
    if (row.approved_amount != null && value.v > row.approved_amount) return fail('Processed amount cannot exceed the approved amount.');
    delete patch.decision_notes;
    Object.assign(patch, { processing_status: 'processed', processed_amount: value.v, processed_reference: `${reference} — ${notes}`, processed_at: now, processed_by: actor.email });
    }
  } else if (decision === 'reopen') {
    if (row.status !== 'approved' || row.processing_status === 'processed') return fail('Only unprocessed approved requests can be reopened.');
    Object.assign(patch, { status: 'rework', approved_by: null, approved_at: null, approved_amount: null, rework_notes: notes, reworked_by: actor.email, reworked_at: now, decided_by: actor.email, decided_at: now });
    if (row.request_type === 'hold_waiver') {
      const details = { ...row.details }; delete details.approved_waiver_days;
      patch.details = details;
    }
  } else {
    if (!['pending_l2', 'submitted'].includes(row.status)) return fail('Only pending requests can be decided.');
    Object.assign(patch, { status: decision === 'approve' ? 'approved' : decision === 'reject' ? 'rejected' : 'rework', decided_by: actor.email, decided_at: now });
    if (decision === 'approve') {
      if (row.request_type === 'hold_waiver') {
        const days = holdWaiverDays(row.details ?? {});
        if (days == null) return fail('Enter valid hold start and end dates before approving the waiver.');
        Object.assign(patch, { approved_by: actor.email, approved_at: now, approved_amount: null, details: { ...row.details, approved_waiver_days: String(days) } });
      } else if (['cash_discount', 'grn_delay_waiver', 'surplus_fabric_consumption'].includes(row.request_type)) {
        if (row.request_type === 'surplus_fabric_consumption') {
          const increase = fabricConsumptionIncrease(row.details?.initial_consumption ?? '', row.details?.revised_consumption ?? '');
          if (!increase || increase.percent <= 1) return fail('The increase in average fabric consumption must be greater than 1%.');
          patch.details = { ...row.details, increased_consumption: String(increase.amount), consumption_increase_percent: String(increase.percent) };
        }
        if (row.request_type === 'grn_delay_waiver') {
          const days = grnDelayDays(row.details ?? {});
          if (days == null || days <= 7) return fail('GRN date must be more than 7 days after the goods delivery date.');
          patch.details = { ...row.details, grn_delay_days: String(days) };
        }
        Object.assign(patch, { approved_by: actor.email, approved_at: now, approved_amount: null });
      } else {
      const approved = parseAmount(formData.get('approved_amount'));
      const requested = commercialImpact(row.request_type, row.details, row.increment_amount, row.invoice_amount, row.credit_amount);
      if (!approved.ok || (requested != null && approved.v == null)) return fail('Enter the approved amount.');
      if (requested != null && approved.v != null && approved.v > requested) return fail('Approved amount cannot exceed requested amount.');
      Object.assign(patch, { approved_by: actor.email, approved_at: now, approved_amount: approved.v });
      }
    }
    if (decision === 'reject') patch.rejection_notes = notes;
    if (decision === 'rework') Object.assign(patch, { rework_notes: notes, reworked_by: actor.email, reworked_at: now });
  }
  const { data: saved, error } = await db.from(TABLE as never).update(patch as never).eq('id', id).eq('revision', revision).select('id').maybeSingle();
  if (error) return fail(error.message);
  if (!saved) return fail('Request changed while you were reviewing. Refresh and try again.');
  await commercialNotice({ title: `Commercial request #${id}: ${decision}`, body: notes || 'Your request has a new decision.', recipient_email: row.requested_by, created_by: actor.email, link: row.requested_by?.endsWith('@saadaa.in') ? '/vendor-commercial' : '/commercial-requests' });
  refreshCommercial();
  return done('Commercial request updated.');
}

export async function linkCommercialVendor(formData: FormData): Promise<ActionResult> {
  const actor = await commercialActor();
  if (!actor || actor.vendorCode || actor.role !== 'admin') return fail('Admin access required.');
  const email = String(formData.get('email') ?? '').trim().toLowerCase();
  if (!validVendorEmail(email)) return fail('Enter a valid external vendor email address.');
  const vendorCode = String(formData.get('vendor_code') ?? '').trim().toUpperCase();
  const db = createAdminClient();
  let user;
  try { user = await findCommercialAuthUser(email); }
  catch { return fail('Could not look up the vendor account. Please retry.'); }
  if (!user) return fail('No login exists for this email. Use Create vendor login first.');
  const { data: vendor } = await db.from('vendor_master_data').select('vendor_code,is_active').eq('vendor_code', vendorCode).maybeSingle();
  if (!vendor?.is_active) return fail('Choose an active vendor.');
  const { error } = await db.from('sd_commercial_vendor_account' as never).upsert({ user_id: user.id, email, vendor_code: vendorCode, is_active: formData.get('is_active') === 'true', updated_by: actor.email, updated_at: new Date().toISOString() } as never);
  if (error) return fail(error.message);
  refreshCommercial();
  return done('Vendor access updated.');
}

const validVendorEmail = (email: string) => /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email) && !email.endsWith('@saadaa.in');

async function findCommercialAuthUser(email: string) {
  const db = createAdminClient();
  for (let page = 1; ; page++) {
    const { data, error } = await db.auth.admin.listUsers({ page, perPage: 100 });
    if (error) throw new Error('Account lookup failed.');
    const users = data.users;
    const found = users.find((user) => user.email?.toLowerCase() === email);
    if (found) return found;
    if (users.length < 100) return null;
  }
}

/** Admin provisions a password login and vendor mapping without exposing Auth IDs. */
export async function createCommercialVendorLogin(formData: FormData): Promise<ActionResult> {
  const actor = await commercialActor();
  if (!actor || actor.vendorCode || actor.role !== 'admin') return fail('Admin access required.');
  const email = String(formData.get('email') ?? '').trim().toLowerCase();
  const password = String(formData.get('password') ?? '');
  const name = String(formData.get('full_name') ?? '').trim();
  const vendorCode = String(formData.get('vendor_code') ?? '').trim().toUpperCase();
  if (!validVendorEmail(email)) return fail('Enter a valid external vendor email address.');
  if (password.length < 12 || password.length > 128) return fail('Use a password between 12 and 128 characters.');
  if (!name || name.length > 200) return fail('Enter the vendor contact name (up to 200 characters).');
  const db = createAdminClient();
  const { data: vendor, error: vendorError } = await db.from('vendor_master_data').select('vendor_code,is_active').eq('vendor_code', vendorCode).maybeSingle();
  if (vendorError || !vendor?.is_active) return fail('Choose an active vendor.');
  try {
    if (await findCommercialAuthUser(email)) return fail('This email already has a login. Use Manage existing access; its password has not been changed.');
  } catch { return fail('Could not check existing accounts. Please retry.'); }
  const { data, error } = await db.auth.admin.createUser({ email, password, email_confirm: true, user_metadata: { full_name: name }, app_metadata: { commercial_password_change_required: true } });
  if (error || !data.user) return fail('Could not create this login. Check the email and password requirements, or manage the existing account.');
  const { error: linkError } = await db.from('sd_commercial_vendor_account' as never).insert({ user_id: data.user.id, email, vendor_code: vendorCode, is_active: true, updated_by: actor.email, updated_at: new Date().toISOString() } as never);
  if (linkError) {
    // Compensate only for the new user created by this operation; existing users are never deleted or reset.
    const { error: cleanupError } = await db.auth.admin.deleteUser(data.user.id);
    return fail(cleanupError ? 'Login created, but vendor access could not be saved. Use Manage existing access to finish linking it.' : 'Vendor access could not be saved. No login was retained; please retry.');
  }
  refreshCommercial();
  return done(`Vendor login created for ${email}. Share the temporary password securely; the vendor must change it on first login.`);
}
