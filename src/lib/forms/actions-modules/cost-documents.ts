'use server';

import { randomUUID } from 'node:crypto';
import { revalidatePath } from 'next/cache';
import { createAdminClient, hasSupabaseAdminEnv } from '@/lib/supabase/admin';
import { currentUser } from '../queries';
import { canEdit } from '../approval';
import { COST_DOC_BUCKET, costDocFileError, fileExt, isCostDocGroup } from '@/lib/cost-documents';
import { done, fail, supa, type ActionResult } from './_shared';

/*
 * Standard Cost → Documents tab (2026-10-09): CAD plans in four groups (RFP / CAD links stay on Final Cost).
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

/** Remove a document and its file — the person who added it, or an admin. */
export async function deleteCostDocument(formData: FormData): Promise<ActionResult> {
  const user = await currentUser();
  if (!user) return fail('Not signed in.');
  const id = Number(formData.get('id'));
  if (!id) return fail('Invalid document.');
  const supabase = await supa();
  const { data } = await supabase.from(SDOC).select('id, product_code, file_path, file_name, created_by').eq('id', id).maybeSingle();
  const doc = data as { id: number; product_code: string; file_path: string; file_name: string; created_by: string | null } | null;
  if (!doc) return fail('Document not found.');
  const mine = (doc.created_by ?? '').toLowerCase() === user.email.toLowerCase();
  if (user.role !== 'admin' && !mine) return fail('Only the person who added it or an admin can remove this document.');
  const { error } = await supabase.from(SDOC).delete().eq('id', id);
  if (error) return fail(error.message);
  if (hasSupabaseAdminEnv()) await createAdminClient().storage.from(COST_DOC_BUCKET).remove([doc.file_path]);
  // Removal is kept by the audit trail (sd_audit), not logged as a decision.
  revalidatePath('/standard-cost');
  return done('Document removed.');
}
