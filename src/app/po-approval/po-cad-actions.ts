'use server';

import { randomUUID } from 'node:crypto';
import { revalidatePath } from 'next/cache';
import { currentUser } from '@/lib/forms/queries';
import { client, pageAll } from '@/lib/forms/queries-modules/_shared';
import { createAdminClient } from '@/lib/supabase/admin';
import { canEdit } from '@/lib/forms/approval';
import { canEditPoSection } from '@/lib/po-rework';
import { canView } from '@/lib/views';
import { PO_CAD_BUCKET, poCadFileError, type PoCadDocument, type PoCadUploadInput } from '@/lib/po-cad';

function databaseError(error: { message: string; code?: string }) {
  return new Error(['42P01', 'PGRST205'].includes(error.code ?? '') ? 'PO CAD storage setup must be applied before attachments can be used.' : error.message);
}
async function parent(poId: number, write = false) {
  const user = await currentUser();
  if (!user || user.is_active === false || !canView('/po-approval', user.role, user.allowed_pages ?? null)) throw new Error('PO Approval access is required to view CAD plans.');
  if (!Number.isSafeInteger(poId) || poId <= 0) throw new Error('Save the PO Order step before attaching CAD plans.');
  const db = await client();
  const { data: po, error } = await db.from('sd_po_approval').select('id,status,rework_sections').eq('id', poId).maybeSingle();
  if (error) throw databaseError(error);
  if (!po) throw new Error('PO not found.');
  if (write && (!canEdit(user.role, po.status) || !canEditPoSection(po, 'cost'))) throw new Error('CAD plans can only be changed while this PO Cost section is editable.');
  return { db, user, po };
}
async function document(id: number, write = false) {
  const user = await currentUser();
  if (!user || user.is_active === false || !canView('/po-approval', user.role, user.allowed_pages ?? null)) throw new Error('PO Approval access is required to view CAD plans.');
  const db = await client();
  const { data, error } = await db.from('sd_po_cad_document').select('*').eq('id', id).is('removed_at', null).maybeSingle();
  if (error) throw databaseError(error);
  if (!data) throw new Error('CAD plan not found.');
  const doc = data as PoCadDocument;
  await parent(Number(doc.po_id), write);
  return { doc, user };
}
export async function loadPoCadDocuments(poId: number): Promise<PoCadDocument[]> {
  const { db } = await parent(poId);
  return pageAll<PoCadDocument>(() => db.from('sd_po_cad_document').select('*').eq('po_id', poId).is('removed_at', null).not('uploaded_at', 'is', null).order('created_at').order('id'));
}
export async function startPoCadUpload(poId: number, input: PoCadUploadInput) {
  const { user } = await parent(poId, true);
  const invalid = poCadFileError(input);
  if (invalid) throw new Error(invalid);
  const admin = createAdminClient();
  const path = `${poId}/${randomUUID()}.pdf`;
  const { data: ticket, error: ticketError } = await admin.from('sd_po_cad_document').insert({ po_id: poId, file_path: path, file_name: input.name.trim(), file_size: input.size, doc_group: input.group, width: input.group === 'full_layer' ? input.width.trim() : null, remark: input.remark.trim() || null, created_by: user.email }).select('id').single();
  if (ticketError || !ticket) throw databaseError(ticketError ?? { message: 'Could not register CAD upload.' });
  const { data, error } = await admin.storage.from(PO_CAD_BUCKET).createSignedUploadUrl(path);
  if (error || !data) throw new Error('Could not start the upload. Check that PO CAD storage setup is applied.');
  return { id: Number(ticket.id), path, token: data.token };
}
export async function finishPoCadUpload(id: number) {
  const { doc, user } = await document(id, true);
  if (doc.created_by !== user.email) throw new Error('Only the uploader can finish this CAD upload.');
  const admin = createAdminClient();
  const fileName = doc.file_path.split('/')[1];
  const { data: files, error } = await admin.storage.from(PO_CAD_BUCKET).list(String(doc.po_id), { search: fileName, limit: 2 });
  if (error || !files?.some(file => file.name === fileName && Number(file.metadata?.size) === Number(doc.file_size) && file.metadata?.mimetype === 'application/pdf')) throw new Error('The CAD PDF upload is missing or incomplete. Please upload it again.');
  const { data: saved, error: saveError } = await admin.from('sd_po_cad_document').update({ uploaded_at: new Date().toISOString() }).eq('id', id).is('removed_at', null).select('id').maybeSingle();
  if (saveError) throw databaseError(saveError);
  if (!saved) throw new Error('This CAD plan changed while uploading. Reload and try again.');
  revalidatePath('/po-approval'); revalidatePath(`/po-approval/${doc.po_id}`);
  return true;
}
export async function removePoCadDocument(id: number) {
  const { doc, user } = await document(id, true);
  const { data: removed, error } = await createAdminClient().from('sd_po_cad_document').update({ removed_at: new Date().toISOString(), removed_by: user.email }).eq('id', id).is('removed_at', null).select('id').maybeSingle();
  if (error) throw databaseError(error);
  if (!removed) throw new Error('This CAD plan has already changed. Reload the PO.');
  revalidatePath('/po-approval'); revalidatePath(`/po-approval/${doc.po_id}`);
}
export async function openPoCadDocument(id: number) {
  const { doc } = await document(id);
  if (!doc.uploaded_at) throw new Error('Finish uploading the CAD plan before opening it.');
  const { data, error } = await createAdminClient().storage.from(PO_CAD_BUCKET).createSignedUrl(doc.file_path, 600);
  if (error || !data) throw new Error('Could not open the CAD plan.');
  return data.signedUrl;
}
