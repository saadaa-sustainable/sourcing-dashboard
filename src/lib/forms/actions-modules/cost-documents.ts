'use server';

import { randomUUID } from 'node:crypto';
import { revalidatePath } from 'next/cache';
import { createAdminClient, hasSupabaseAdminEnv } from '@/lib/supabase/admin';
import { createNotification } from '@/lib/notifications.server';
import { currentUser } from '../queries';
import { canEdit } from '../approval';
import { loadCadCheckers } from '../queries-modules/cost-documents';
import { COST_DOC_BUCKET, COST_DOC_GROUP_LABEL, costDocFileError, fileExt, isCostDocGroup } from '@/lib/cost-documents';
import { done, fail, supa, writeLog, type ActionResult } from './_shared';

/*
 * Standard Cost documents (2026-10-09): CAD plans in four groups + the RFP sheet link.
 *   1. startCostDocumentUpload → a one-time signed upload URL for a server-chosen path
 *   2. the browser uploads the file straight to storage (no Vercel request-size limit)
 *   3. addCostDocument → confirms the file landed and files it under its group, waiting for
 *      the CAD check (L1); decisions go through decideApproval ('cost_document').
 */

// Paths this module hands out: <product>/<uuid>.<ext>. Nothing else is accepted back.
const PATH_RE = /^[A-Za-z0-9_-]{1,60}\/[0-9a-f-]{36}\.[a-z0-9]{1,5}$/;
const safeCode = (code: string) => code.trim().replace(/[^A-Za-z0-9_-]/g, '_').slice(0, 60) || 'product';
const SDOC = 'sd_cost_document' as never;

async function tellCadCheckers(productCode: string, fileName: string, by: string) {
  const checkers = await loadCadCheckers();
  const title = `CAD to check: ${productCode} · ${fileName}`;
  const link = `/standard-cost/${encodeURIComponent(productCode)}`;
  if (!checkers.length) {
    await createNotification({ kind: 'cad_check', title, link, audienceRole: 'team', createdBy: by });
    return;
  }
  for (const to of checkers) {
    if (to !== by.toLowerCase()) await createNotification({ kind: 'cad_check', title, link, recipientEmail: to, createdBy: by });
  }
}

export async function startCostDocumentUpload(
  productCode: string,
  fileName: string,
  size: number,
): Promise<{ ok: true; path: string; token: string } | { ok: false; error: string }> {
  const user = await currentUser();
  if (!user) return { ok: false, error: 'Not signed in.' };
  if (!canEdit(user.role, 'draft')) return { ok: false, error: 'Only team and admin users can add documents.' };
  if (!hasSupabaseAdminEnv()) return { ok: false, error: 'File storage is not configured.' };
  const bad = costDocFileError(String(fileName ?? ''), Number(size));
  if (bad) return { ok: false, error: bad };
  const path = `${safeCode(String(productCode ?? ''))}/${randomUUID()}.${fileExt(String(fileName))}`;
  const { data, error } = await createAdminClient().storage.from(COST_DOC_BUCKET).createSignedUploadUrl(path);
  if (error || !data) return { ok: false, error: 'Could not start the upload — has the cost-documents migration been applied?' };
  return { ok: true, path: data.path, token: data.token };
}

/** File an uploaded CAD plan under its group, with its remark. It waits for the CAD check (L1). */
export async function addCostDocument(formData: FormData): Promise<ActionResult> {
  const user = await currentUser();
  if (!user) return fail('Not signed in.');
  if (!canEdit(user.role, 'draft')) return fail('Only team and admin users can add documents.');
  const productCode = String(formData.get('product_code') ?? '').trim();
  const group = String(formData.get('doc_group') ?? '');
  const path = String(formData.get('file_path') ?? '');
  const fileName = String(formData.get('file_name') ?? '').trim().slice(0, 200);
  const size = Number(formData.get('file_size') ?? 0);
  const remark = String(formData.get('remark') ?? '').trim().slice(0, 1000);
  if (!productCode) return fail('Missing product.');
  if (!isCostDocGroup(group)) return fail('Pick where this CAD plan belongs.');
  if (!PATH_RE.test(path) || !path.startsWith(`${safeCode(productCode)}/`)) return fail('Attach the file again.');
  const admin = createAdminClient();
  const { data: exists } = await admin.storage.from(COST_DOC_BUCKET).exists(path);
  if (!exists) return fail('The file did not finish uploading. Please attach it again.');

  const supabase = await supa();
  const now = new Date().toISOString();
  const { data, error } = await supabase
    .from(SDOC)
    .insert({ product_code: productCode, doc_group: group, file_path: path, file_name: fileName || 'file', file_size: size || null, remark: remark || null, status: 'submitted', created_by: user.email, submitted_at: now, updated_at: now } as never)
    .select('id')
    .maybeSingle();
  if (error) return fail(error.message);
  const id = String((data as { id: number } | null)?.id ?? '');
  await writeLog('cost_document', id, `CAD — ${productCode} · ${COST_DOC_GROUP_LABEL[group]}`, null, 'submitted', user.email, remark || `Added ${fileName}`);
  await tellCadCheckers(productCode, fileName, user.email);
  revalidatePath('/standard-cost');
  revalidatePath('/approvals');
  return done('Added — waiting for the CAD check (L1).');
}

/** After Rework / Reassign: put the corrected file (and remark) in place and send it back to L1. */
export async function replaceCostDocument(formData: FormData): Promise<ActionResult> {
  const user = await currentUser();
  if (!user) return fail('Not signed in.');
  if (!canEdit(user.role, 'draft')) return fail('Only team and admin users can replace documents.');
  const id = Number(formData.get('id'));
  const path = String(formData.get('file_path') ?? '');
  const fileName = String(formData.get('file_name') ?? '').trim().slice(0, 200);
  const size = Number(formData.get('file_size') ?? 0);
  const remark = String(formData.get('remark') ?? '').trim().slice(0, 1000);
  if (!id) return fail('Invalid document.');
  const supabase = await supa();
  const { data: row } = await supabase.from(SDOC).select('id, product_code, doc_group, file_path, status').eq('id', id).maybeSingle();
  const doc = row as { id: number; product_code: string; doc_group: string; file_path: string; status: string } | null;
  if (!doc) return fail('Document not found.');
  if (doc.status !== 'rework') return fail('Only a document sent for Rework / Reassign can be replaced.');
  if (!PATH_RE.test(path) || !path.startsWith(`${safeCode(doc.product_code)}/`)) return fail('Attach the file again.');
  const admin = createAdminClient();
  const { data: exists } = await admin.storage.from(COST_DOC_BUCKET).exists(path);
  if (!exists) return fail('The file did not finish uploading. Please attach it again.');
  const now = new Date().toISOString();
  const { data: upd, error } = await supabase
    .from(SDOC)
    .update({ file_path: path, file_name: fileName || 'file', file_size: size || null, remark: remark || null, status: 'submitted', submitted_at: now, l1_approved_by: null, l1_approved_at: null, updated_at: now } as never)
    .eq('id', id)
    .eq('status', 'rework')
    .select('id');
  if (error) return fail(error.message);
  if (!(upd as unknown[] | null)?.length) return fail('Already changed by someone else — reload.');
  await admin.storage.from(COST_DOC_BUCKET).remove([doc.file_path]);
  await writeLog('cost_document', String(id), `CAD — ${doc.product_code}`, 'rework', 'submitted', user.email, `Replaced with ${fileName}${remark ? ` — ${remark}` : ''}`);
  await tellCadCheckers(doc.product_code, fileName, user.email);
  revalidatePath('/standard-cost');
  revalidatePath('/approvals');
  return done('Replaced — back with the CAD check (L1).');
}

/** Short-lived link to open a document (signed-in SAADAA users; RLS decides on the row). */
export async function signCostDocument(id: number): Promise<{ url: string } | { error: string }> {
  const user = await currentUser();
  if (!user) return { error: 'Not signed in.' };
  if (!hasSupabaseAdminEnv()) return { error: 'File storage is not configured.' };
  const supabase = await supa();
  const { data } = await supabase.from(SDOC).select('file_path, file_name').eq('id', id).maybeSingle();
  const row = data as { file_path: string; file_name: string } | null;
  if (!row) return { error: 'Document not found.' };
  const { data: signed, error } = await createAdminClient()
    .storage.from(COST_DOC_BUCKET)
    .createSignedUrl(row.file_path, 600, { download: row.file_name });
  if (error || !signed) return { error: error?.message ?? 'Could not open the file.' };
  return { url: signed.signedUrl };
}

/** Remove a document and its file. The uploader while it is not approved; an admin any time. */
export async function deleteCostDocument(formData: FormData): Promise<ActionResult> {
  const user = await currentUser();
  if (!user) return fail('Not signed in.');
  const id = Number(formData.get('id'));
  if (!id) return fail('Invalid document.');
  const supabase = await supa();
  const { data } = await supabase.from(SDOC).select('id, product_code, file_path, file_name, status, created_by').eq('id', id).maybeSingle();
  const doc = data as { id: number; product_code: string; file_path: string; file_name: string; status: string; created_by: string | null } | null;
  if (!doc) return fail('Document not found.');
  const mine = (doc.created_by ?? '').toLowerCase() === user.email.toLowerCase();
  if (user.role !== 'admin' && !(mine && doc.status !== 'approved')) {
    return fail('Only the person who added it (before approval) or an admin can remove this document.');
  }
  const { error } = await supabase.from(SDOC).delete().eq('id', id);
  if (error) return fail(error.message);
  if (hasSupabaseAdminEnv()) await createAdminClient().storage.from(COST_DOC_BUCKET).remove([doc.file_path]);
  // Removal is kept by the audit trail (sd_audit), not logged as a decision.
  revalidatePath('/standard-cost');
  revalidatePath('/approvals');
  return done('Document removed.');
}

/** Admin: who does the L1 CAD check (comma- or line-separated emails; empty = any team member). */
export async function saveCadCheckers(formData: FormData): Promise<ActionResult> {
  const user = await currentUser();
  if (!user) return fail('Not signed in.');
  if (user.role !== 'admin') return fail('Only an admin can set the CAD checker.');
  const emails = [...new Set(String(formData.get('emails') ?? '')
    .split(/[\s,;]+/)
    .map((e) => e.trim().toLowerCase())
    .filter(Boolean))];
  const bad = emails.find((e) => !/^[^@\s]+@[^@\s]+\.[a-z]{2,}$/.test(e));
  if (bad) return fail(`"${bad}" is not an email address.`);
  const supabase = await supa();
  const { error: delErr } = await supabase.from('sd_cad_checker' as never).delete().neq('email', '');
  if (delErr) return fail(delErr.message);
  if (emails.length) {
    const { error } = await supabase
      .from('sd_cad_checker' as never)
      .insert(emails.map((email) => ({ email, added_by: user.email })) as never);
    if (error) return fail(error.message);
  }
  revalidatePath('/standard-cost');
  return done(emails.length ? `CAD checker set (${emails.length}).` : 'CAD checker cleared — any team member can do the L1 check.');
}

/** The cost's RFP sheet link (sd_standard_cost.rfp_link). */
export async function saveRfpLink(formData: FormData): Promise<ActionResult> {
  const user = await currentUser();
  if (!user) return fail('Not signed in.');
  if (!canEdit(user.role, 'draft')) return fail('Only team and admin users can change the RFP sheet link.');
  const id = Number(formData.get('id'));
  const link = String(formData.get('rfp_link') ?? '').trim();
  if (!id) return fail('Invalid cost.');
  if (link && !/^https?:\/\/\S+$/i.test(link)) return fail('Paste the full link, starting with https://');
  const supabase = await supa();
  const { error } = await supabase.from('sd_standard_cost').update({ rfp_link: link || null, updated_at: new Date().toISOString() }).eq('id', id);
  if (error) return fail(error.message);
  revalidatePath('/standard-cost');
  return done(link ? 'RFP sheet link saved.' : 'RFP sheet link removed.');
}
