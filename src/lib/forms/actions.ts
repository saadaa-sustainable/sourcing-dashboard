'use server';

/**
 * Write path for the sourcing workflows.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 *  ARCHITECTURE RULE: two classes of table, never mixed.
 *
 *  MIRROR tables  — pending_po_master, vendor_type_master, vendor_master_data,
 *                   tna_tracker. Google Sheets is the source of truth. Written
 *                   only by apps-script/Code.gs with the service role. READ ONLY
 *                   from the app.
 *
 *  OWNED tables   — everything prefixed sd_. Supabase is the source of truth.
 *                   Written only from here, with the signed-in user's JWT so RLS
 *                   applies.
 *
 *  Never add an sd_ table to CONFIG in Code.gs. That sync deactivates every row
 *  whose sync_token does not match the current run — one pass would wipe the
 *  table.
 * ─────────────────────────────────────────────────────────────────────────────
 */

import { revalidatePath } from 'next/cache';
import { createClient, hasSupabaseEnv } from '@/lib/supabase/server';
import { currentUser } from './queries';
import { canApprove, canEdit, canSubmit, statusOnSubmit } from './approval';
import type { ApprovalEntity, SdStatus } from './types';

export type ActionResult = { ok: true; message?: string } | { ok: false; error: string };

const fail = (error: string): ActionResult => ({ ok: false, error });
const done = (message?: string): ActionResult => ({ ok: true, message });

async function supa() {
  if (!hasSupabaseEnv()) throw new Error('Supabase is not configured.');
  return createClient();
}

async function writeLog(
  entityType: ApprovalEntity,
  entityId: string,
  entityLabel: string,
  fromStatus: SdStatus | null,
  toStatus: SdStatus,
  actorEmail: string,
  notes?: string,
) {
  // Audit is best effort: a failed log must never roll back the transition.
  try {
    const supabase = await supa();
    await supabase.from('sd_approval_log').insert({
      entity_type: entityType,
      entity_id: entityId,
      entity_label: entityLabel,
      from_status: fromStatus,
      to_status: toStatus,
      actor_email: actorEmail,
      notes: notes ?? null,
    });
  } catch (error) {
    console.error('sd_approval_log insert failed', error);
  }
}

/* ================================================================== */
/* Buying plan                                                         */
/* ================================================================== */

export async function saveBuyingPlan(formData: FormData): Promise<ActionResult> {
  const user = await currentUser();
  if (!user) return fail('Not signed in.');

  const planMonth = String(formData.get('plan_month') ?? '');
  if (!/^\d{4}-\d{2}-01$/.test(planMonth)) return fail('Invalid plan month.');

  let lines: Array<Record<string, unknown>>;
  try {
    lines = JSON.parse(String(formData.get('lines') ?? '[]'));
  } catch {
    return fail('Could not read the plan lines.');
  }

  const supabase = await supa();

  const { data: existing } = await supabase
    .from('sd_buying_plan')
    .select('id, status')
    .eq('plan_month', planMonth)
    .maybeSingle();

  const status = (existing?.status ?? 'draft') as SdStatus;
  if (!canEdit(user.role, status)) {
    return fail(
      status === 'approved'
        ? 'This plan is approved and can no longer be edited.'
        : 'You do not have permission to edit the buying plan.',
    );
  }

  let planId = existing?.id as number | undefined;
  if (!planId) {
    const { data, error } = await supabase
      .from('sd_buying_plan')
      .insert({ plan_month: planMonth, status: 'draft' })
      .select('id')
      .single();
    if (error) return fail(`Could not create the plan: ${error.message}`);
    planId = data.id as number;
  }

  // Full replace of the line set. Simplest correct behaviour for a monthly
  // document that is edited as a whole sheet.
  const { error: delError } = await supabase
    .from('sd_buying_plan_line')
    .delete()
    .eq('plan_id', planId);
  if (delError) return fail(`Could not clear old lines: ${delError.message}`);

  const payload = lines
    .filter((line) => String(line.product_code ?? '').trim())
    .map((line) => ({
      plan_id: planId,
      product_code: String(line.product_code).trim(),
      product_status: line.product_status ? String(line.product_status) : null,
      fabric_type: line.fabric_type ? String(line.fabric_type) : null,
      pending_quantity:
        line.pending_quantity === '' || line.pending_quantity == null
          ? null
          : Number(line.pending_quantity),
      job_work_qty: Number(line.job_work_qty ?? 0) || 0,
      fob_qty: Number(line.fob_qty ?? 0) || 0,
      efob_qty: Number(line.efob_qty ?? 0) || 0,
      standard_value:
        line.standard_value === '' || line.standard_value == null
          ? null
          : Number(line.standard_value),
    }));

  if (payload.length) {
    for (let i = 0; i < payload.length; i += 500) {
      const { error } = await supabase
        .from('sd_buying_plan_line')
        .insert(payload.slice(i, i + 500));
      if (error) return fail(`Could not save lines: ${error.message}`);
    }
  }

  revalidatePath('/buying-plan');
  return done(`Saved ${payload.length} product lines.`);
}

export async function submitBuyingPlan(formData: FormData): Promise<ActionResult> {
  const user = await currentUser();
  if (!user) return fail('Not signed in.');

  const planId = Number(formData.get('plan_id'));
  if (!planId) return fail('Save the plan before submitting it.');

  const supabase = await supa();
  const { data: plan } = await supabase
    .from('sd_buying_plan')
    .select('id, plan_month, status')
    .eq('id', planId)
    .maybeSingle();
  if (!plan) return fail('Plan not found.');
  if (!canSubmit(user.role, plan.status as SdStatus)) {
    return fail('This plan cannot be submitted from its current state.');
  }

  const { data: lines } = await supabase
    .from('sd_buying_plan_line')
    .select('job_work_qty, fob_qty, efob_qty')
    .eq('plan_id', planId);
  const qty = ((lines ?? []) as Record<string, number>[]).reduce(
    (sum, l) =>
      sum +
      Number(l.job_work_qty || 0) +
      Number(l.fob_qty || 0) +
      Number(l.efob_qty || 0),
    0,
  );
  if (qty <= 0) return fail('Allocate at least one quantity before submitting.');

  const next = statusOnSubmit('buying_plan', qty);

  // Guarded update: if another user already moved it, zero rows match.
  const { data: updated, error } = await supabase
    .from('sd_buying_plan')
    .update({
      status: next,
      submitted_by: user.email,
      submitted_at: new Date().toISOString(),
      rejection_notes: null,
    })
    .eq('id', planId)
    .eq('status', 'draft')
    .select('id');
  if (error) return fail(error.message);
  if (!updated?.length) return fail('Already submitted by someone else.');

  await writeLog(
    'buying_plan',
    String(planId),
    `Buying plan ${String(plan.plan_month).slice(0, 7)}`,
    'draft',
    next,
    user.email,
  );
  revalidatePath('/buying-plan');
  revalidatePath('/approvals');
  return done('Submitted for approval.');
}

/* ================================================================== */
/* Vendor capacity — no approval, append only                          */
/* ================================================================== */

export async function submitVendorCapacity(formData: FormData): Promise<ActionResult> {
  const user = await currentUser();
  if (!user) return fail('Not signed in.');
  if (!canEdit(user.role, 'draft')) {
    return fail('You do not have permission to submit vendor capacity.');
  }

  const week = String(formData.get('week_of') ?? '');
  if (!/^\d{4}-\d{2}-\d{2}$/.test(week)) return fail('Invalid week.');

  let rows: Array<Record<string, unknown>>;
  try {
    rows = JSON.parse(String(formData.get('rows') ?? '[]'));
  } catch {
    return fail('Could not read the capacity rows.');
  }

  const payload = rows
    .filter((row) => String(row.vendor_code ?? '').trim())
    .map((row) => ({
      vendor_code: String(row.vendor_code).trim(),
      vendor_name: row.vendor_name ? String(row.vendor_name) : null,
      week_of: week,
      machines_allocated: numOrNull(row.machines_allocated),
      active_karigar: numOrNull(row.active_karigar),
      capacity_per_month: numOrNull(row.capacity_per_month),
      machines_at_onboarding: numOrNull(row.machines_at_onboarding),
      capacity_signed: numOrNull(row.capacity_signed),
      submitted_by: user.email,
      submitted_at: new Date().toISOString(),
    }));

  if (!payload.length) return fail('Nothing to submit.');

  const supabase = await supa();
  // Append-only log. A resubmit within the same week overwrites that week's row
  // rather than creating a second one; history across weeks is never touched.
  for (let i = 0; i < payload.length; i += 500) {
    const { error } = await supabase
      .from('sd_vendor_capacity_log')
      .upsert(payload.slice(i, i + 500), { onConflict: 'vendor_code,week_of' });
    if (error) return fail(`Could not save capacity: ${error.message}`);
  }

  revalidatePath('/vendor-capacity');
  return done(`Capacity recorded for ${payload.length} vendors.`);
}

function numOrNull(value: unknown) {
  if (value === '' || value == null) return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

/* ================================================================== */
/* Discontinue                                                         */
/* ================================================================== */

export async function createDiscontinueRequest(
  formData: FormData,
): Promise<ActionResult> {
  const user = await currentUser();
  if (!user) return fail('Not signed in.');
  if (!canEdit(user.role, 'draft')) {
    return fail('You do not have permission to raise a discontinue request.');
  }

  const productCode = String(formData.get('product_code') ?? '').trim();
  const variant = String(formData.get('product_variant') ?? '').trim();
  const reason = String(formData.get('reason') ?? '').trim();
  if (!productCode || !variant) return fail('Pick a product code and variant.');

  const supabase = await supa();
  const { data, error } = await supabase
    .from('sd_discontinue_request')
    .insert({
      product_code: productCode,
      product_variant: variant,
      reason: reason || null,
      status: statusOnSubmit('discontinue'),
      requested_by: user.email,
      requested_at: new Date().toISOString(),
    })
    .select('id')
    .single();

  if (error) {
    return fail(
      error.code === '23505'
        ? 'A live request already exists for this variant.'
        : error.message,
    );
  }

  await writeLog(
    'discontinue',
    String(data.id),
    `${productCode} / ${variant}`,
    'draft',
    statusOnSubmit('discontinue'),
    user.email,
    reason || undefined,
  );
  revalidatePath('/discontinue');
  revalidatePath('/approvals');
  return done('Discontinue request submitted.');
}

/* ================================================================== */
/* Shared approve / reject                                             */
/* ================================================================== */

const TABLE: Record<ApprovalEntity, string> = {
  buying_plan: 'sd_buying_plan',
  discontinue: 'sd_discontinue_request',
  po_approval: 'sd_po_approval',
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

  if (!table || !entityId) return fail('Invalid approval request.');
  if (decision !== 'approve' && decision !== 'reject') {
    return fail('Invalid decision.');
  }

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

  const to: SdStatus = decision === 'approve' ? 'approved' : 'rejected';
  const patch: Record<string, unknown> =
    decision === 'approve'
      ? { status: to, approved_by: user.email, approved_at: new Date().toISOString() }
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

  revalidatePath('/approvals');
  revalidatePath('/buying-plan');
  revalidatePath('/discontinue');
  return done(decision === 'approve' ? 'Approved.' : 'Rejected.');
}
