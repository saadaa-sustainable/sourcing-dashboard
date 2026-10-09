'use server';

import { randomUUID } from 'node:crypto';
import { revalidatePath } from 'next/cache';
import { createAdminClient, hasSupabaseAdminEnv } from '@/lib/supabase/admin';
import { currentUser } from '../queries';
import { canEdit } from '../approval';
import { COST_DOC_BUCKET, costDocFileError, fileExt, isCostDocGroup } from '@/lib/cost-documents';
import { done, fail, supa, type ActionResult } from './_shared';

/*
 * Standard Cost → Documents tab (2026-10-09): CAD plans in four groups (Full layer = width + link
 * entries, the rest uploaded files) + the RFP sheet link.
 *   1. startCostDocumentUpload → a one-time signed upload URL for a server-chosen path
 *   2. the browser uploads the file straight to storage (no Vercel request-size limit)
 *   3. addCostDocument → confirms the file landed and files it under its group with its remark.
 * No approval on documents (user, 2026-10-09).
 */

// Paths this module hands out: <product>/<uuid>.<ext>. Nothing else is accepted back.
const PATH_RE = /^[A-Za-z0-9_-]{1,60}\/[0-9a-f-]{36}\.[a-z0-9]{1,5}$/;
const safeCode = (code: string) => code.trim().replace(/[^A-Za-z0-9_-]/g, '_').slice(0, 60) || 'product';
const SDOC = 'sd_cost_document' as never;

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

/** File an uploaded CAD plan under its group, with its remark. */
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
  if (group === 'full_layer') return fail('Full layer plans are added as a width and a link.');
  if (!PATH_RE.test(path) || !path.startsWith(`${safeCode(productCode)}/`)) return fail('Attach the file again.');
  const admin = createAdminClient();
  const { data: exists } = await admin.storage.from(COST_DOC_BUCKET).exists(path);
  if (!exists) return fail('The file did not finish uploading. Please attach it again.');

  const supabase = await supa();
  const { error } = await supabase
    .from(SDOC)
    .insert({ product_code: productCode, doc_group: group, file_path: path, file_name: fileName || 'file', file_size: size || null, remark: remark || null, created_by: user.email } as never);
  if (error) return fail(error.message);
  revalidatePath('/standard-cost');
  return done('Document added.');
}

/**
 * Full layer · single size per width: one fabric width + the shared link to its plan. A
 * product can carry as many widths as it is cut in.
 */
export async function addCostWidthLink(formData: FormData): Promise<ActionResult> {
  const user = await currentUser();
  if (!user) return fail('Not signed in.');
  if (!canEdit(user.role, 'draft')) return fail('Only team and admin users can add documents.');
  const productCode = String(formData.get('product_code') ?? '').trim();
  const width = String(formData.get('width') ?? '').trim().replace(/\s*(["″]|in(ch(es)?)?)$/i, '').slice(0, 20);
  const link = String(formData.get('link_url') ?? '').trim();
  const remark = String(formData.get('remark') ?? '').trim().slice(0, 1000);
  if (!productCode) return fail('Missing product.');
  if (!width) return fail('Type or pick the fabric width.');
  if (!/^https?:\/\/\S+$/i.test(link)) return fail('Paste the full link, starting with https://');
  const supabase = await supa();
  const { error } = await supabase
    .from(SDOC)
    .insert({ product_code: productCode, doc_group: 'full_layer', width, link_url: link, remark: remark || null, created_by: user.email } as never);
  if (error) return fail(/column|constraint/i.test(error.message) ? 'Width links need the database update 20261009130000_cost_document_width_links.sql.' : error.message);
  revalidatePath('/standard-cost');
  return done(`Full layer plan for ${width}${/^\d+(\.\d+)?$/.test(width) ? '″' : ''} width added.`);
}

/** Short-lived link to open a document (signed-in SAADAA users; RLS decides on the row). */
export async function signCostDocument(id: number): Promise<{ url: string } | { error: string }> {
  const user = await currentUser();
  if (!user) return { error: 'Not signed in.' };
  if (!hasSupabaseAdminEnv()) return { error: 'File storage is not configured.' };
  const supabase = await supa();
  const { data } = await supabase.from(SDOC).select('file_path, file_name').eq('id', id).maybeSingle();
  const row = data as { file_path: string | null; file_name: string | null } | null;
  if (!row) return { error: 'Document not found.' };
  if (!row.file_path) return { error: 'This entry is a link, not a file.' };
  const { data: signed, error } = await createAdminClient()
    .storage.from(COST_DOC_BUCKET)
    .createSignedUrl(row.file_path, 600, { download: row.file_name ?? true });
  if (error || !signed) return { error: error?.message ?? 'Could not open the file.' };
  return { url: signed.signedUrl };
}

/** Remove a document and its file — the person who added it, or an admin. */
export async function deleteCostDocument(formData: FormData): Promise<ActionResult> {
  const user = await currentUser();
  if (!user) return fail('Not signed in.');
  const id = Number(formData.get('id'));
  if (!id) return fail('Invalid document.');
  const supabase = await supa();
  const { data } = await supabase.from(SDOC).select('id, product_code, file_path, file_name, created_by').eq('id', id).maybeSingle();
  const doc = data as { id: number; product_code: string; file_path: string | null; file_name: string | null; created_by: string | null } | null;
  if (!doc) return fail('Document not found.');
  const mine = (doc.created_by ?? '').toLowerCase() === user.email.toLowerCase();
  if (user.role !== 'admin' && !mine) return fail('Only the person who added it or an admin can remove this document.');
  const { error } = await supabase.from(SDOC).delete().eq('id', id);
  if (error) return fail(error.message);
  if (doc.file_path && hasSupabaseAdminEnv()) await createAdminClient().storage.from(COST_DOC_BUCKET).remove([doc.file_path]);
  // Removal is kept by the audit trail (sd_audit), not logged as a decision.
  revalidatePath('/standard-cost');
  return done('Document removed.');
}

/** The cost's RFP sheet link (sd_standard_cost.rfp_link), saved from the Documents tab. CAD
 *  plans live in the CAD plan library, not in a link. */
export async function saveCostLinks(formData: FormData): Promise<ActionResult> {
  const user = await currentUser();
  if (!user) return fail('Not signed in.');
  if (!canEdit(user.role, 'draft')) return fail('Only team and admin users can change the RFP sheet link.');
  const id = Number(formData.get('id'));
  if (!id) return fail('Invalid cost.');
  const rfp = String(formData.get('rfp_link') ?? '').trim();
  if (rfp && !/^https?:\/\/\S+$/i.test(rfp)) return fail('Paste the full link, starting with https://');
  const supabase = await supa();
  const { data: row } = await supabase.from('sd_standard_cost').select('frozen').eq('id', id).maybeSingle();
  if (!row) return fail('Cost not found.');
  if ((row as { frozen: boolean | null }).frozen) return fail('This cost is frozen (a PO was issued on it) and cannot be changed.');
  const { error } = await supabase
    .from('sd_standard_cost')
    .update({ rfp_link: rfp || null, updated_at: new Date().toISOString() })
    .eq('id', id);
  if (error) return fail(error.message);
  revalidatePath('/standard-cost');
  return done('RFP sheet link saved.');
}
