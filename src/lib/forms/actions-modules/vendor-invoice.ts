'use server';

import { randomBytes, randomUUID } from 'node:crypto';
import { revalidatePath } from 'next/cache';
import { createAdminClient, hasSupabaseAdminEnv } from '@/lib/supabase/admin';
import { currentUser } from '../queries';
import { canEdit } from '../approval';
import { done, fail, supa, type ActionResult } from './_shared';
import { resolveViewToken } from '@/lib/vendor-invoice-view';
import { VI_BUCKET, VI_MAX_BYTES, validateViDraft, type ViDraft } from '@/lib/vendor-invoice';

/*
 * Vendor Invoices - Accounts. The public page (/vendor-invoice) needs no login, like the
 * Google Form it replaces, so these two actions run with the service-role client and do
 * every check themselves; anon has no grant on the table or the bucket.
 *   1. startVendorInvoiceUpload -> a one-time signed upload URL for a server-chosen path
 *   2. the browser uploads the PDF straight to storage (no request-size limit on Vercel)
 *   3. submitVendorInvoice -> validates the answers, confirms the PDF landed, inserts
 */

// Paths this action hands out: <yyyy-mm>/<uuid>.pdf. Submit accepts nothing else.
const PATH_RE = /^\d{4}-\d{2}\/[0-9a-f-]{36}\.pdf$/;

export async function startVendorInvoiceUpload(
  fileName: string,
  size: number,
): Promise<{ ok: true; path: string; token: string } | { ok: false; error: string }> {
  if (!hasSupabaseAdminEnv()) return { ok: false, error: 'Uploads are not configured. Please contact the SAADAA Accounts team.' };
  if (!/\.pdf$/i.test(String(fileName ?? ''))) return { ok: false, error: 'Upload a PDF file only.' };
  if (!(size > 0)) return { ok: false, error: 'The file is empty.' };
  if (size > VI_MAX_BYTES) return { ok: false, error: 'The PDF is larger than 10 MB.' };
  const path = `${new Date().toISOString().slice(0, 7)}/${randomUUID()}.pdf`;
  const { data, error } = await createAdminClient().storage.from(VI_BUCKET).createSignedUploadUrl(path);
  if (error || !data) return { ok: false, error: 'Could not start the upload. Please try again.' };
  return { ok: true, path: data.path, token: data.token };
}

export async function submitVendorInvoice(
  draft: ViDraft,
  filePath: string,
  fileName: string,
  honeypot = '',
): Promise<ActionResult> {
  // A filled hidden field means a bot; answer as if it worked and store nothing.
  if (String(honeypot ?? '').trim()) return done('Submitted.');
  if (!hasSupabaseAdminEnv()) return fail('Submissions are not configured. Please contact the SAADAA Accounts team.');

  const checked = validateViDraft(draft);
  if (!checked.ok) return fail(checked.error);
  const path = String(filePath ?? '');
  if (!PATH_RE.test(path)) return fail('Attach the document PDF.');

  const admin = createAdminClient();
  const { data: exists } = await admin.storage.from(VI_BUCKET).exists(path);
  if (!exists) return fail('The PDF did not finish uploading. Please attach it again.');

  // A signed-in SAADAA user keying an entry for a vendor is recorded as such.
  let byEmail: string | null = null;
  try {
    byEmail = (await currentUser())?.email ?? null;
  } catch {
    byEmail = null;
  }

  const { error } = await admin.from('sd_vendor_invoice').insert({
    ...checked.row,
    file_path: path,
    file_name: String(fileName ?? '').slice(0, 200) || null,
    submitted_via: byEmail ? 'dashboard' : 'public_link',
    submitted_by_email: byEmail,
  });
  if (error) {
    if (error.code === '23505') return fail('This PDF was already submitted.');
    return fail('Could not save your entry. Please try again.');
  }
  revalidatePath('/vendor-invoices');
  return done('Submitted.');
}

/** Short-lived signed URL to open an entry's PDF (signed-in SAADAA users only). */
export async function signVendorInvoiceFile(id: number): Promise<{ url: string } | { error: string }> {
  const user = await currentUser();
  if (!user) return { error: 'Not signed in.' };
  if (!hasSupabaseAdminEnv()) return { error: 'Storage not configured.' };
  // Read through the user's own client, so RLS decides whether they may see the entry.
  const supabase = await supa();
  const { data } = await supabase.from('sd_vendor_invoice').select('file_path').eq('id', id).maybeSingle();
  const path = (data as { file_path: string } | null)?.file_path;
  if (!path) return { error: 'Entry not found.' };
  const { data: signed, error } = await createAdminClient().storage.from(VI_BUCKET).createSignedUrl(path, 600);
  if (error || !signed) return { error: error?.message ?? 'Could not open the file.' };
  return { url: signed.signedUrl };
}

/** Remove a junk or duplicate entry and its PDF. Admins only — the link is open to anyone. */
export async function deleteVendorInvoice(id: number): Promise<ActionResult> {
  const user = await currentUser();
  if (!user) return fail('Not signed in.');
  if (user.role !== 'admin') return fail('Only an admin can delete an entry.');
  if (!hasSupabaseAdminEnv()) return fail('Storage not configured.');
  const admin = createAdminClient();
  const { data } = await admin.from('sd_vendor_invoice').select('file_path').eq('id', id).maybeSingle();
  const path = (data as { file_path: string } | null)?.file_path;
  if (!path) return fail('Entry not found.');
  const { error } = await admin.from('sd_vendor_invoice').delete().eq('id', id);
  if (error) return fail(`Could not delete: ${error.message}`);
  await admin.storage.from(VI_BUCKET).remove([path]);
  revalidatePath('/vendor-invoices');
  return done('Entry deleted.');
}

/* ---- Per-vendor view links (the vendor's "pending and filled invoices" page) ---- */

export async function createVendorViewLink(
  vendorCode: string,
): Promise<{ ok: true; token: string } | { ok: false; error: string }> {
  const user = await currentUser();
  if (!user) return { ok: false, error: 'Not signed in.' };
  if (!canEdit(user.role, 'draft')) return { ok: false, error: 'You do not have permission to create vendor links.' };
  if (!hasSupabaseAdminEnv()) return { ok: false, error: 'Storage not configured.' };
  const code = String(vendorCode ?? '').trim().toUpperCase();
  if (!/^[A-Z0-9_-]{1,20}$/.test(code)) return { ok: false, error: 'Choose a vendor code.' };
  const token = randomBytes(24).toString('base64url');
  const { error } = await createAdminClient()
    .from('sd_vendor_view_link')
    .insert({ token, vendor_code: code, created_by: user.email });
  if (error) return { ok: false, error: `Could not create the link: ${error.message}` };
  revalidatePath('/vendor-invoices');
  return { ok: true, token };
}

export async function revokeVendorViewLink(id: number): Promise<ActionResult> {
  const user = await currentUser();
  if (!user) return fail('Not signed in.');
  if (!canEdit(user.role, 'draft')) return fail('You do not have permission to revoke vendor links.');
  if (!hasSupabaseAdminEnv()) return fail('Storage not configured.');
  const { error } = await createAdminClient()
    .from('sd_vendor_view_link')
    .update({ revoked_at: new Date().toISOString(), revoked_by: user.email })
    .eq('id', id)
    .is('revoked_at', null);
  if (error) return fail(`Could not revoke: ${error.message}`);
  revalidatePath('/vendor-invoices');
  return done('Link revoked. The vendor can no longer open it.');
}

/** A vendor opening one of their own PDFs from their link. The entry must be theirs. */
export async function signVendorViewFile(token: string, id: number): Promise<{ url: string } | { error: string }> {
  const link = await resolveViewToken(String(token ?? ''));
  if (!link) return { error: 'This link is no longer active.' };
  const admin = createAdminClient();
  const code = link.vendor_code.toUpperCase();
  const { data } = await admin.from('sd_vendor_invoice').select('file_path, vendor_code, po_ref_num').eq('id', id).maybeSingle();
  const entry = data as { file_path: string; vendor_code: string | null; po_ref_num: string } | null;
  if (!entry) return { error: 'Entry not found.' };
  let mine = entry.vendor_code?.toUpperCase() === code;
  if (!mine && entry.vendor_code == null) {
    // A code-less entry is theirs when the PO is one of their POs.
    const po = entry.po_ref_num.trim();
    // paging-ok: existence check, one row
    const { data: hit } = await admin
      .from('sd_po_master_raw')
      .select('po_id')
      .eq('vendor_code', code)
      .or(`po_ref_num.ilike.${po.replace(/[,()*%]/g, '')},po_number.eq.${po.replace(/[,()*%]/g, '')}`)
      .limit(1);
    mine = !!hit?.length;
  }
  if (!mine) return { error: 'Entry not found.' };
  const { data: signed, error } = await admin.storage.from(VI_BUCKET).createSignedUrl(entry.file_path, 600);
  if (error || !signed) return { error: 'Could not open the file.' };
  return { url: signed.signedUrl };
}
