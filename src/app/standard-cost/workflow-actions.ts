'use server';

import { randomUUID } from 'node:crypto';
import { revalidatePath } from 'next/cache';
import { createAdminClient } from '@/lib/supabase/admin';
import { COST_DOC_BUCKET, COST_DOC_MAX_BYTES } from '@/lib/cost-documents';
import { costSnapshot, costWorkflowUser, loadCostWorkflow } from '@/lib/standard-cost-workflow.server';
import { requireFinishedGoodsMasterProduct } from '@/lib/finished-goods-cost.server';
import { COST_SECTIONS, changedCostSections, parseCostSnapshot, validateCostSnapshot, type CostRevision, type CostSection, type CostSnapshot } from '@/lib/standard-cost-workflow';

export async function loadReferenceCost(code: string) {
  await costWorkflowUser(true);
  return costSnapshot(code);
}

export async function workflowCadUpload(code: string, name: string, size: number) {
  await costWorkflowUser(true);
  const { data: parent } = await createAdminClient().from('sd_standard_cost').select('id').eq('product_code', code).maybeSingle();
  if (!parent) throw new Error('Cost record not found.');
  if (!/\.pdf$/i.test(name) || !(size > 0 && size <= COST_DOC_MAX_BYTES)) throw new Error('Attach a CAD PDF up to 25 MB.');
  const prefix = code.replace(/[^A-Za-z0-9_-]/g, '_').slice(0, 60);
  const path = `${prefix}/${randomUUID()}.pdf`;
  const { data, error } = await createAdminClient().storage.from(COST_DOC_BUCKET).createSignedUploadUrl(path);
  if (error || !data) throw new Error(error?.message ?? 'Could not start upload.');
  return { path, token: data.token };
}

export async function openWorkflowCad(code: string, path: string) {
  await costWorkflowUser();
  const [snapshot, workflow] = await Promise.all([costSnapshot(code), loadCostWorkflow(code)]);
  const permitted = [snapshot, ...workflow.revisions.map(r => r.payload), ...workflow.revisions.map(r => r.base)].some(s => s.documents.files.some(f => f.file_path === path));
  if (!permitted) throw new Error('Save the submission before opening this CAD.');
  const { data, error } = await createAdminClient().storage.from(COST_DOC_BUCKET).createSignedUrl(path, 600);
  if (error || !data) throw new Error('Could not open CAD.');
  return data.signedUrl;
}

export async function saveCostWorkflow(input: { code: string; op: 'save' | 'submit' | 'approve' | 'reject' | 'rework'; id: number | null; version: number; payload: CostSnapshot; baseline: CostSnapshot; reason: string; reference: string | null; sections: CostSection[] }) {
  try {
    const user = await costWorkflowUser(true);
    await requireFinishedGoodsMasterProduct(input.code);
    if (!['save','submit','approve','reject','rework'].includes(input.op)) throw new Error('Invalid action.');
    if (!Array.isArray(input.sections) || input.sections.some(s => !COST_SECTIONS.includes(s))) throw new Error('Invalid sections.');
    if (['approve','reject','rework'].includes(input.op) && user.role !== 'admin') throw new Error('Only admin can decide.');
    const db = createAdminClient();
    let revision: CostRevision | null = null;
    if (input.id !== null) {
      const { data, error } = await db.from('sd_cost_revision').select('*').eq('id', input.id).eq('product_code', input.code).maybeSingle();
      if (error || !data) throw new Error('Submission not found.');
      revision = data as CostRevision;
      if (revision.status === 'approved') throw new Error('Approved submissions are locked. Start an amendment.');
      if (['save','submit'].includes(input.op) && revision.owner.toLowerCase() !== user.email.toLowerCase() && user.role !== 'admin') throw new Error('Only the owner or admin can edit.');
    }
    const base = revision?.base ?? await costSnapshot(input.code);
    const { data: parent } = await db.from('sd_standard_cost').select('status, neg_stage').eq('product_code', input.code).single();
    const { count } = await db.from('sd_standard_cost_rate_history').select('id', { count: 'exact', head: true }).eq('product_code', input.code);
    const isNew = revision ? revision.kind === 'new' : parent?.status !== 'approved' && parent?.neg_stage !== 'signed_off' && !count;
    if (typeof input.reason !== 'string' || input.reason.length > 2000 || (input.reference !== null && (typeof input.reference !== 'string' || input.reference.length > 100))) throw new Error('Invalid reason or reference product.');
    const payload = parseCostSnapshot(input.op === 'approve' ? input.payload : ['reject','rework'].includes(input.op) ? revision!.payload : input.payload);
    if (user.role !== 'admin' && ['save','submit'].includes(input.op)) {
      for (const key of ['target_job','target_fob','target_efob'] as const) {
        if ((payload.rates[key] ?? null) !== ((revision?.payload ?? base).rates[key] ?? null)) throw new Error('Only admin can change target rates.');
      }
    }
    const sections = isNew ? [...COST_SECTIONS] : changedCostSections(base, payload);
    const validate = input.op === 'submit' || input.op === 'approve';
    if (validate) {
      const errors = validateCostSnapshot(payload, input.op === 'approve' && !isNew ? input.sections : sections.filter(s => !revision?.approved_sections.includes(s)), isNew);
      const hasUpdatedCadPdf = payload.documents.files.some(file => file.file_path && /\.pdf$/i.test(file.file_name ?? '') && !base.documents.files.some(existing => existing.file_path === file.file_path));
      const hasCadPlanLink = /^https?:\/\/\S+$/i.test(payload.documents.cad_link) || payload.documents.files.some(file => /^https?:\/\/\S+$/i.test(file.link_url ?? ''));
      if (!isNew && !hasUpdatedCadPdf) errors.push('Upload a CAD PDF file before submitting an amendment.');
      if (!hasCadPlanLink) errors.push('Add at least one valid CAD plan link before submitting.');
      const overrun = !isNew && sections.includes('rates') && (['job_cost','fob_cost','efob_cost'] as const).some(key => payload.rates[key] != null && base.rates[key] != null && payload.rates[key]! > base.rates[key]!);
      if (isNew && input.op === 'approve' && ['target_job','target_fob','target_efob'].some(key => payload.rates[key as keyof typeof payload.rates] == null)) errors.push('Set all three target rates before approving the first cost.');
      if (!input.reason.trim() && input.op !== 'approve') errors.push(overrun ? 'A reason is required because the proposed rate exceeds the current approved standard cost.' : 'A submission / amendment reason is required.');
      if (errors.length) throw new Error(errors.join(' '));
    }
    // Validate file provenance on every save, and storage existence before submission/approval.
    const prefix = input.code.replace(/[^A-Za-z0-9_-]/g, '_').slice(0, 60) + '/';
    const checkDocuments = isNew || (validate && !isNew) || (input.op === 'approve' ? input.sections : sections).includes('documents');
    for (const file of payload.documents.files) {
      const inherited = base.documents.files.some(f => f.file_path === file.file_path);
      if (inherited && !isNew) continue;
      if (!file.file_path) continue;
      if (!file.file_path.startsWith(prefix) || !/^[A-Za-z0-9_-]{1,60}\/[0-9a-f-]{36}\.[a-z0-9]{1,5}$/.test(file.file_path)) throw new Error('CAD must be uploaded for this product.');
      if (validate && checkDocuments) {
        const { data: exists, error } = await db.storage.from(COST_DOC_BUCKET).exists(file.file_path);
        if (error || !exists) throw new Error('A CAD upload is missing. Attach it again.');
        if (/\.pdf$/i.test(file.file_name ?? '')) {
          if (!/\.pdf$/i.test(file.file_path)) throw new Error('CAD PDFs must be uploaded as PDF files.');
          const { data: blob, error: readError } = await db.storage.from(COST_DOC_BUCKET).download(file.file_path);
          if (readError || !blob || !(await blob.slice(0, 5).text()).startsWith('%PDF-')) throw new Error('The CAD file is not a valid PDF. Upload its PDF export.');
        }
      }
    }
    const { data, error } = await db.rpc('sd_cost_workflow', { p_code: input.code, p_op: input.op, p_id: input.id, p_version: input.version, p_payload: payload, p_base: input.id === null ? parseCostSnapshot(input.baseline) : null, p_reason: input.reason, p_reference: input.reference, p_sections: input.sections, p_actor: user.email, p_admin: user.role === 'admin' });
    if (error) throw new Error(error.message);
    revalidatePath('/standard-cost');
    revalidatePath(`/standard-cost/${encodeURIComponent(input.code)}`);
    revalidatePath('/buying-plan');
    return { ok: true as const, id: Number(data) };
  } catch (error) {
    return { ok: false as const, error: error instanceof Error ? error.message : 'Could not save the cost workflow.' };
  }
}
