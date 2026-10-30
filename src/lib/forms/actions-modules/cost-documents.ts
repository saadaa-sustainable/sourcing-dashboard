'use server';

import { randomUUID } from 'node:crypto';
import { createAdminClient, hasSupabaseAdminEnv } from '@/lib/supabase/admin';
import { currentUser } from '../queries';
import { canEdit } from '../approval';
import { COST_DOC_BUCKET, costDocFileError, fileExt } from '@/lib/cost-documents';
import { fail, supa, type ActionResult } from './_shared';

/*
 * Standard Cost → Documents tab (2026-10-09): CAD plans in four groups — each takes files and/or
 * shared links; Full layer entries also carry the fabric width — + the RFP sheet link.
 *   1. startCostDocumentUpload → a one-time signed upload URL for a server-chosen path
 *   2. the browser uploads the file straight to storage (no Vercel request-size limit)
 *   3. addCostDocument → confirms the file landed and files it under its group with its remark.
 *   A link goes in through addCostLink (no upload).
 * Writes are now staged in workflow-actions.ts; legacy entry points refuse direct saves.
 */

// Paths this module hands out: <product>/<uuid>.<ext>. Nothing else is accepted back.
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
  void formData;
  return fail('Use the Standard Cost submission / amendment workflow on the product page.');
}

/** A shared link to a CAD plan, filed under its group (Full layer: with its fabric width). */
export async function addCostLink(formData: FormData): Promise<ActionResult> {
  void formData;
  return fail('Use the Standard Cost submission / amendment workflow on the product page.');
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
  void formData;
  return fail('Use the Standard Cost submission / amendment workflow on the product page.');
}

/** The cost's RFP sheet link (sd_standard_cost.rfp_link), saved from the Documents tab. CAD
 *  plans live in the CAD plan library, not in a link. */
export async function saveCostLinks(formData: FormData): Promise<ActionResult> {
  void formData;
  return fail('Use the Standard Cost submission / amendment workflow on the product page.');
}
