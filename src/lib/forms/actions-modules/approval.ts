'use server';

import { randomBytes } from 'crypto';
import { revalidatePath } from 'next/cache';
import { createClient, hasSupabaseEnv } from '@/lib/supabase/server';
import { createAdminClient, hasSupabaseAdminEnv } from '@/lib/supabase/admin';
import { createPublicClient } from '@/lib/supabase/public';
import { computeClosureCompliance } from '@/lib/business-logic';
import { recomputeExpectedCost } from '@/lib/standard-cost';
import { currentUser, loadApprovedStandardCosts, loadApprovedMaterialCosts } from '../queries';
import { canApprove, canEdit, canSubmit, statusOnSubmit } from '../approval';
import {
  canAcceptProposal,
  canConfirmCm,
  canConfirmFabric,
  canPropose,
  canRejectCost,
  canRenegotiate,
  canSetTarget,
  canSignOff,
  canSubmitRate,
} from '../cost';
import type { ApprovalEntity, PoCategory, PoType, SdRole, SdStatus } from '../types';
import { INWARD_PLAN_STATUSES } from '../types';
import { notifyReworkSlack } from '@/lib/slack';
import {
  type ActionResult,
  type LinkResult,
  fail,
  done,
  supa,
  writeLog,
  recordCommitment,
  numOrNull,
  dateOrNull,
  textOrNull,
} from './_shared';

const TABLE: Record<ApprovalEntity, string> = {
  buying_plan: 'sd_buying_plan',
  discontinue: 'sd_discontinue_request',
  po_approval: 'sd_po_approval',
  standard_cost: 'sd_standard_cost',
  material_cost: 'sd_material_standard_cost',
  receivable_plan: 'sd_receivable_input',
  inward_plan: 'sd_inward_plan_entry',
};

// Entities that carry line items eligible for line-item rework.
const LINE_TABLE: Partial<Record<ApprovalEntity, string>> = {
  buying_plan: 'sd_buying_plan_line',
  po_approval: 'sd_po_approval_line',
};

export async function decideApproval(formData: FormData): Promise<ActionResult> {
  const user = await currentUser();
  if (!user) return fail('Not signed in.');

  const entityType = String(formData.get('entity_type') ?? '') as ApprovalEntity;
  const entityId = Number(formData.get('entity_id'));
  const label = String(formData.get('entity_label') ?? '');
  const decision = String(formData.get('decision') ?? '');
  const notes = String(formData.get('notes') ?? '').trim();
  const table = TABLE[entityType];

  if (decision !== 'approve' && decision !== 'reject' && decision !== 'rework') {
    return fail('Invalid decision.');
  }
  if ((decision === 'reject' || decision === 'rework') && !notes) {
    return fail('A reason is required to reject or send for rework.');
  }

  // Receivable plan is a batch of row_key-keyed rows, not one id record — decide
  // the whole submitted batch in one go (keeps ApprovalBar reusable for it).
  if (entityType === 'receivable_plan') {
    return decideReceivablePlanBulk(user.role, user.email, decision, notes, label);
  }

  if (!table || !entityId) return fail('Invalid approval request.');

  const supabase = await supa();
  const { data: row } = await supabase
    .from(table)
    .select('id, status')
    .eq('id', entityId)
    .maybeSingle();
  if (!row) return fail('Record not found.');

  const from = row.status as SdStatus;
  if (!canApprove(user.role, from)) {
    return fail('This decision is above your approval level.');
  }

  // Hard gate: a PO's cost cannot be approved until its TNA critical-path dates are
  // confirmed and locked by the approver (see confirmTna). Rejection is always allowed.
  //
  // NOTE (spec §5): the CMTP-deviation hard-block (block approval when the PO's CMTP
  // is above the product's standard CMTP unless the approver confirms with a remark)
  // is DEFERRED — for now the approval cost tab shows the CMTP-vs-standard comparison
  // for review only, and does not block. The block will be added later.
  if (entityType === 'po_approval' && decision === 'approve') {
    const { data: po } = await supabase
      .from('sd_po_approval')
      .select('tna_confirmed')
      .eq('id', entityId)
      .maybeSingle();
    if (!po?.tna_confirmed) {
      return fail('Confirm the TNA dates before approving this PO.');
    }
  }

  const to: SdStatus =
    decision === 'approve' ? 'approved' : decision === 'rework' ? 'rework' : 'rejected';
  const now = new Date().toISOString();
  const patch: Record<string, unknown> =
    decision === 'approve'
      ? { status: to, approved_by: user.email, approved_at: now }
      : decision === 'rework'
        ? {
            status: to,
            rework_notes: notes,
            reworked_by: user.email,
            reworked_at: now,
            // Mark so a later approval counts as Edited-and-Approved.
            edited_before_approval: true,
          }
        : { status: to, rejection_notes: notes || null };

  // Atomic: the status guard means a second approver gets zero rows back.
  const { data: updated, error } = await supabase
    .from(table)
    .update(patch)
    .eq('id', entityId)
    .eq('status', from)
    .select('id');

  if (error) return fail(error.message);
  if (!updated?.length) return fail('Already processed by another approver.');

  await writeLog(entityType, String(entityId), label, from, to, user.email, notes || undefined);

  if (decision === 'rework') {
    await notifyReworkSlack({ what: label || `${entityType} #${entityId}`, by: user.email, reason: notes });
  }

  revalidatePath('/approvals');
  revalidatePath('/buying-plan');
  revalidatePath('/discontinue');
  revalidatePath('/po-approval');
  revalidatePath('/standard-cost');
  return done(
    decision === 'approve' ? 'Approved.' : decision === 'rework' ? 'Sent for rework.' : 'Rejected.',
  );
}

/**
 * Line-item rework: send specific lines back with their own reason (the per-line
 * pop-up). Each flagged line gets line_status='rework' + its note; the parent
 * record moves to 'rework' and is marked edited so a later approval counts as edited.
 */
export async function reworkLines(formData: FormData): Promise<ActionResult> {
  const user = await currentUser();
  if (!user) return fail('Not signed in.');
  const entityType = String(formData.get('entity_type') ?? '') as ApprovalEntity;
  const entityId = Number(formData.get('entity_id'));
  const label = String(formData.get('entity_label') ?? '');
  const table = TABLE[entityType];
  const lineTable = LINE_TABLE[entityType];
  if (!table || !lineTable || !entityId) return fail('Invalid rework request.');
  let decisions: { lineId: string; note: string }[] = [];
  try {
    decisions = JSON.parse(String(formData.get('line_decisions') ?? '[]'));
  } catch {
    decisions = [];
  }
  decisions = decisions.filter((d) => d && d.lineId && String(d.note ?? '').trim());
  if (!decisions.length) return fail('Flag at least one line and give each a reason.');

  const supabase = await supa();
  const { data: row } = await supabase.from(table).select('id, status').eq('id', entityId).maybeSingle();
  if (!row) return fail('Record not found.');
  const from = row.status as SdStatus;
  if (!canApprove(user.role, from)) return fail('This decision is above your approval level.');

  const now = new Date().toISOString();
  for (const d of decisions) {
    await supabase
      .from(lineTable)
      .update({ line_status: 'rework', rework_notes: d.note.trim() })
      .eq('id', Number(d.lineId));
  }
  const summary = `${decisions.length} line(s) sent for rework`;
  const { data: updated, error } = await supabase
    .from(table)
    .update({
      status: 'rework',
      rework_notes: summary,
      reworked_by: user.email,
      reworked_at: now,
      edited_before_approval: true,
    })
    .eq('id', entityId)
    .eq('status', from)
    .select('id');
  if (error) return fail(error.message);
  if (!updated?.length) return fail('Already processed by another approver.');

  await writeLog(entityType, String(entityId), label, from, 'rework', user.email, summary);
  await notifyReworkSlack({
    what: label || `${entityType} #${entityId}`,
    by: user.email,
    reason: summary,
    scope: `${decisions.length} lines`,
  });
  revalidatePath('/approvals');
  revalidatePath('/buying-plan');
  revalidatePath('/po-approval');
  return done('Lines sent for rework.');
}

async function decideReceivablePlanBulk(
  role: SdRole,
  email: string,
  decision: string,
  notes: string,
  label: string,
): Promise<ActionResult> {
  const from: SdStatus = 'submitted';
  if (!canApprove(role, from)) return fail('This decision is above your approval level.');
  const now = new Date().toISOString();
  const to: SdStatus =
    decision === 'approve' ? 'approved' : decision === 'rework' ? 'rework' : 'rejected';
  const patch: Record<string, unknown> =
    decision === 'approve'
      ? { status: to, approved_by: email, approved_at: now }
      : decision === 'rework'
        ? {
            status: to,
            rework_notes: notes,
            reworked_by: email,
            reworked_at: now,
            edited_before_approval: true,
          }
        : { status: to, rejection_notes: notes || null };
  const supabase = await supa();
  const { error } = await supabase
    .from('sd_receivable_input')
    .update(patch)
    .eq('status', from);
  if (error) return fail(error.message);
  await writeLog('receivable_plan', 'batch', label || 'Receivable plan', from, to, email, notes || undefined);
  revalidatePath('/approvals');
  revalidatePath('/receivable-plan');
  return done(
    decision === 'approve' ? 'Approved.' : decision === 'rework' ? 'Sent for rework.' : 'Rejected.',
  );
}

/** Bulk-submit the weekly receivable inputs (all drafts) for approval. */
