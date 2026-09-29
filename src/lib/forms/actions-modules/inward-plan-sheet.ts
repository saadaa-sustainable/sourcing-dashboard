'use server';

import { revalidatePath } from 'next/cache';
import { currentUser } from '../queries';
import { canApprove, canEdit } from '../approval';
import { INWARD_PLAN_STATUSES } from '../types';
import type { SdStatus } from '../types';
import { parseInwardPlanCsv } from '@/lib/inward-plan-csv';
import { type ActionResult, fail, done, supa, writeLog } from './_shared';

const MONTH_RE = /^\d{4}-\d{2}-01$/;
const monthLabel = (month: string) =>
  new Date(`${month}T00:00:00`).toLocaleDateString('en-IN', { month: 'long', year: 'numeric' });

function revalidate() {
  revalidatePath('/receivable-plan');
  revalidatePath('/approvals');
  revalidatePath('/ppm-prep');
}

/**
 * Load a month of the team's inward-plan sheet from its CSV export. The rows land
 * as Pending and go to the approval queue as one card for the month. Re-importing
 * a month replaces only its still-Pending rows — rows already decided stay as they are.
 */
export async function importInwardPlanSheet(formData: FormData): Promise<ActionResult> {
  const user = await currentUser();
  if (!user) return fail('Not signed in.');
  if (!canEdit(user.role, 'draft')) return fail('Only team and admin users can load the inward plan.');

  const month = String(formData.get('plan_month') ?? '').trim();
  if (!MONTH_RE.test(month)) return fail('Pick the plan month.');
  const csv = String(formData.get('csv') ?? '');
  if (!csv.trim()) return fail('The file is empty.');

  const parsed = parseInwardPlanCsv(csv);
  if (parsed.error) return fail(parsed.error);
  if (!parsed.rows.length) return fail('No rows with a product code and an inward quantity were found.');

  const supabase = await supa();
  const { data: existing, error: readErr } = await supabase
    .from('sd_inward_plan_entry')
    .select('id, approval_status')
    .eq('plan_month', month);
  if (readErr) return fail(readErr.message);
  const pendingIds = (existing ?? []).filter((r) => r.approval_status === 'Pending').map((r) => r.id as number);
  const decided = (existing ?? []).length - pendingIds.length;

  if (pendingIds.length) {
    const { error } = await supabase.from('sd_inward_plan_entry').delete().in('id', pendingIds);
    if (error) return fail(error.message);
  }
  const now = new Date().toISOString();
  const { error: insErr } = await supabase.from('sd_inward_plan_entry').insert(
    parsed.rows.map((r) => ({
      plan_month: month,
      product_code: r.product_code,
      po_no: r.po_no,
      vendor_name: r.vendor_name,
      inward_qty: r.inward_qty,
      cost_per_piece: r.cost_per_piece,
      approval_status: 'Pending',
      created_by: user.email,
      updated_by: user.email,
      created_at: now,
      updated_at: now,
    })),
  );
  if (insErr) return fail(insErr.message);

  const qty = parsed.rows.reduce((s, r) => s + r.inward_qty, 0);
  await writeLog(
    'inward_plan',
    month,
    `Inward plan — ${monthLabel(month)}`,
    null,
    'pending_l2',
    user.email,
    `Sheet loaded: ${parsed.rows.length} line(s), ${qty.toLocaleString('en-IN')} pcs` +
      (pendingIds.length ? ` (replaced ${pendingIds.length} pending)` : '') +
      (parsed.skipped.length ? ` · ${parsed.skipped.length} line(s) skipped` : ''),
  );
  revalidate();
  const skippedNote = parsed.skipped.length
    ? ` Skipped ${parsed.skipped.length}: ${parsed.skipped.slice(0, 4).map((s) => `line ${s.line} (${s.reason})`).join(', ')}${parsed.skipped.length > 4 ? '…' : ''}.`
    : '';
  return done(
    `Loaded ${parsed.rows.length} line(s), ${qty.toLocaleString('en-IN')} pcs for ${monthLabel(month)} — waiting for approval.` +
      (pendingIds.length ? ` Replaced ${pendingIds.length} pending line(s).` : '') +
      (decided ? ` ${decided} already-decided line(s) were left as they are.` : '') +
      skippedNote,
  );
}

/**
 * Decide one line of the sheet on its own (admin). The month-level decision on
 * Approvals covers the usual case; this is for the odd PO the approver wants to
 * hold back or let through separately.
 */
export async function decideInwardPlanRow(formData: FormData): Promise<ActionResult> {
  const user = await currentUser();
  if (!user) return fail('Not signed in.');
  if (!canApprove(user.role, 'pending_l2')) return fail('Only an admin can decide inward-plan lines.');

  const id = Number(formData.get('id'));
  const status = String(formData.get('status') ?? '');
  const notes = String(formData.get('notes') ?? '').trim();
  if (!id) return fail('Invalid line.');
  if (!INWARD_PLAN_STATUSES.includes(status)) return fail('Invalid status.');
  if ((status === 'Rejected' || status === 'RE-WORK') && !notes) return fail('Give a reason so the team knows what to change.');

  const supabase = await supa();
  const { data: row } = await supabase
    .from('sd_inward_plan_entry')
    .select('id, plan_month, product_code, po_no, approval_status')
    .eq('id', id)
    .maybeSingle();
  if (!row) return fail('Line not found.');
  const { error } = await supabase
    .from('sd_inward_plan_entry')
    .update({ approval_status: status, mt_comments: notes || null, updated_by: user.email, updated_at: new Date().toISOString() })
    .eq('id', id);
  if (error) return fail(error.message);

  const to: SdStatus = status === 'Approved' ? 'approved' : status === 'RE-WORK' ? 'rework' : status === 'Rejected' ? 'rejected' : 'pending_l2';
  const from: SdStatus =
    row.approval_status === 'Approved' ? 'approved' : row.approval_status === 'RE-WORK' ? 'rework' : row.approval_status === 'Rejected' ? 'rejected' : 'pending_l2';
  await writeLog(
    'inward_plan',
    String(row.plan_month),
    `Inward plan — ${monthLabel(String(row.plan_month))} · ${row.product_code} · ${row.po_no ?? '—'}`,
    from,
    to,
    user.email,
    notes || undefined,
  );
  revalidate();
  return done(`${row.product_code} · ${row.po_no ?? '—'} marked ${status}.`);
}

/** Remove a line that has not been decided yet (a wrong PO, a duplicate). */
export async function deleteInwardPlanRow(formData: FormData): Promise<ActionResult> {
  const user = await currentUser();
  if (!user) return fail('Not signed in.');
  if (!canEdit(user.role, 'draft')) return fail('Only team and admin users can edit the inward plan.');
  const id = Number(formData.get('id'));
  if (!id) return fail('Invalid line.');
  const supabase = await supa();
  const { data: row } = await supabase
    .from('sd_inward_plan_entry')
    .select('id, plan_month, product_code, po_no, approval_status')
    .eq('id', id)
    .maybeSingle();
  if (!row) return fail('Line not found.');
  if (row.approval_status !== 'Pending' && user.role !== 'admin') return fail('Only an admin can remove a line that has already been decided.');
  const { error } = await supabase.from('sd_inward_plan_entry').delete().eq('id', id);
  if (error) return fail(error.message);
  await writeLog(
    'inward_plan',
    String(row.plan_month),
    `Inward plan — ${monthLabel(String(row.plan_month))} · ${row.product_code} · ${row.po_no ?? '—'}`,
    'pending_l2',
    'rejected',
    user.email,
    'Line removed from the sheet',
  );
  revalidate();
  return done('Line removed.');
}
