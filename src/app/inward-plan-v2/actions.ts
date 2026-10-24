'use server';

import { revalidatePath } from 'next/cache';
import { redirect } from 'next/navigation';
import { context, validationErrors } from '@/lib/inward-plan-v2/server';
import { parseDraft, UUID } from '@/lib/inward-plan-v2/validation';
import type { Result } from '@/lib/inward-plan-v2/types';

const message = (error: unknown) => error instanceof Error ? error.message : 'The request could not be completed.';
export async function savePlan(_previous: Result, form: FormData): Promise<Result> {
  let id: string;
  const approveEdits = form.get('intent') === 'approve_with_edits';
  try {
    const { db, role } = await context();
    if (role === 'viewer') throw new Error('Only team and admin users can save plans.');
    if (approveEdits && role !== 'admin') throw new Error('Only admin may approve with edits.');
    const notes = String(form.get('approval_notes') ?? '').trim();
    if (approveEdits && notes.length > 4000) throw new Error('Remarks must be at most 4000 characters.');
    const { header, lines } = parseDraft(form);
    if (approveEdits && !header.id) throw new Error('Select an existing pending plan.');
    const payload = {
      p_header: header, p_lines: lines.map(line => ({ id: line.id, planning_level: line.planning_level, po_number: line.po_number, product_code: line.product_code, po_detail_id: line.po_detail_id, expected_date: line.expected_date,
        inward_qty: line.inward_qty, cost_per_piece: line.cost_per_piece, remarks: line.remarks })),
      p_version: String(form.get('version') ?? '') || null,
    };
    const { data, error } = approveEdits
      ? await db.rpc('sd_inward_v2_approve_with_edits', { ...payload, p_notes: notes })
      : await db.rpc('sd_inward_v2_save', payload);
    if (error) throw new Error(error.message);
    if (typeof data !== 'string' || !UUID.test(data)) throw new Error('The save returned no plan ID.');
    id = data;
  } catch (error) { return { ok: false, message: message(error) }; }
  revalidatePath('/inward-plan-v2');
  redirect('/inward-plan-v2?id=' + id + (approveEdits ? '&approved=1' : '&saved=1'));
}
export async function reviewPlan(_previous: Result, form: FormData): Promise<Result> {
  try {
    const { db, role } = await context();
    if (role === 'viewer') throw new Error('Only team and admin users can change plan status.');
    const id = String(form.get('plan_id') ?? form.get('id') ?? '');
    const action = String(form.get('decision') ?? '');
    const notes = String(form.get('notes') ?? '').trim();
    if (!UUID.test(id) || !['submit', 'approve', 'reopen'].includes(action))
      throw new Error('Invalid plan or action.');
    if (notes.length > 4000) throw new Error('Remarks must be at most 4000 characters.');
    const { error } = await db.rpc('sd_inward_v2_decide', {
      p_id: id, p_action: action, p_notes: notes, p_version: String(form.get('version') ?? '') || null,
    });
    if (error) throw new Error(error.message);
    revalidatePath('/inward-plan-v2');
    return { ok: true, message: action === 'submit' ? 'Submitted for approval.' : 'Decision saved.' };
  } catch (error) { return { ok: false, message: message(error) }; }
}
export async function validatePlan(id: string): Promise<Result> {
  try {
    if (!UUID.test(id)) throw new Error('Invalid plan ID.');
    const errors = await validationErrors(id);
    return { ok: !errors.length, message: errors.length ? 'Please resolve these validation issues.' : 'Saved plan is valid.', errors };
  } catch (error) { return { ok: false, message: message(error) }; }
}
