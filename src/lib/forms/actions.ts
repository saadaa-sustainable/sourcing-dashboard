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
import { canApprove, canEdit, canSubmit, routeApproval, statusOnSubmit } from './approval';
import type { ApprovalEntity, PoType, SdRole, SdStatus } from './types';

export type ActionResult =
  | { ok: true; message?: string; id?: number }
  | { ok: false; error: string };

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
  revalidatePath('/po-approval');
  return done(decision === 'approve' ? 'Approved.' : 'Rejected.');
}

/* ================================================================== */
/* PO Approval                                                         */
/* ================================================================== */

const PO_TYPES: PoType[] = ['FG', 'Material', 'NPD'];
const dateOrNull = (v: unknown) =>
  /^\d{4}-\d{2}-\d{2}$/.test(String(v ?? '')) ? String(v) : null;
const textOrNull = (v: unknown) => {
  const s = String(v ?? '').trim();
  return s || null;
};

/** Number of colours = distinct variants known for the product code (from PO data). */
async function countColours(
  supabase: Awaited<ReturnType<typeof supa>>,
  productCode: string | null,
): Promise<number | null> {
  if (!productCode) return null;
  const { data } = await supabase
    .from('sd_po_lines_enriched')
    .select('product_variant')
    .eq('product_code', productCode);
  if (!data?.length) return null;
  const set = new Set(
    (data as { product_variant: string | null }[])
      .map((r) => r.product_variant)
      .filter(Boolean),
  );
  return set.size || null;
}

/** Read the PO Approval fields out of a FormData into a table row. */
function readPoFields(formData: FormData) {
  const rawType = String(formData.get('po_type') ?? 'FG');
  const po_type: PoType = (PO_TYPES.includes(rawType as PoType) ? rawType : 'FG') as PoType;
  return {
    po_ref: textOrNull(formData.get('po_ref')),
    po_type,
    product_code: textOrNull(formData.get('product_code')),
    vendor_code: textOrNull(formData.get('vendor_code')),
    quantity: Number(formData.get('quantity') ?? 0) || 0,
    cost_sheet_link: textOrNull(formData.get('cost_sheet_link')),
    tna_link: textOrNull(formData.get('tna_link')),
    tna_pp_date: dateOrNull(formData.get('tna_pp_date')),
    tna_gpt_date: dateOrNull(formData.get('tna_gpt_date')),
    tna_cutting_date: dateOrNull(formData.get('tna_cutting_date')),
    tna_inline_date: dateOrNull(formData.get('tna_inline_date')),
    closing_date: dateOrNull(formData.get('closing_date')),
  };
}

export async function savePoApproval(formData: FormData): Promise<ActionResult> {
  const user = await currentUser();
  if (!user) return fail('Not signed in.');

  const id = Number(formData.get('id')) || 0;
  const supabase = await supa();

  // Guard edits against the current stored status.
  let status: SdStatus = 'draft';
  if (id) {
    const { data: existing } = await supabase
      .from('sd_po_approval')
      .select('id, status')
      .eq('id', id)
      .maybeSingle();
    if (!existing) return fail('PO not found.');
    status = existing.status as SdStatus;
  }
  if (!canEdit(user.role, status)) {
    return fail(
      status === 'approved'
        ? 'This PO is approved and can no longer be edited.'
        : 'You do not have permission to edit PO approvals.',
    );
  }

  const fields = readPoFields(formData);
  const number_of_colours = await countColours(supabase, fields.product_code);

  if (id) {
    const { error } = await supabase
      .from('sd_po_approval')
      .update({ ...fields, number_of_colours })
      .eq('id', id)
      .eq('status', 'draft');
    if (error) return fail(`Could not save: ${error.message}`);
    revalidatePath('/po-approval');
    return { ok: true, message: 'Saved.', id };
  }

  const { data, error } = await supabase
    .from('sd_po_approval')
    .insert({ ...fields, number_of_colours, status: 'draft' })
    .select('id')
    .single();
  if (error) return fail(`Could not create PO: ${error.message}`);
  revalidatePath('/po-approval');
  return { ok: true, message: `Saved PO #${data.id}.`, id: data.id as number };
}

export async function submitPoApproval(formData: FormData): Promise<ActionResult> {
  const user = await currentUser();
  if (!user) return fail('Not signed in.');

  const id = Number(formData.get('id'));
  if (!id) return fail('Save the PO before submitting it.');

  const supabase = await supa();
  const { data: po } = await supabase
    .from('sd_po_approval')
    .select('id, status, po_ref, po_type, product_code, quantity')
    .eq('id', id)
    .maybeSingle();
  if (!po) return fail('PO not found.');
  if (!canSubmit(user.role, po.status as SdStatus)) {
    return fail('This PO cannot be submitted from its current state.');
  }
  const qty = Number(po.quantity || 0);
  if (qty <= 0) return fail('Enter a quantity before submitting.');

  const next = statusOnSubmit('po_approval', qty, po.po_type as string);
  const { data: updated, error } = await supabase
    .from('sd_po_approval')
    .update({
      status: next,
      submitted_by: user.email,
      submitted_for_approval_at: new Date().toISOString(),
      rejection_notes: null,
    })
    .eq('id', id)
    .eq('status', 'draft')
    .select('id');
  if (error) return fail(error.message);
  if (!updated?.length) return fail('Already submitted by someone else.');

  await writeLog(
    'po_approval',
    String(id),
    `PO ${po.po_ref ?? `#${id}`} · ${po.po_type} · ${po.product_code ?? ''}`.trim(),
    'draft',
    next,
    user.email,
  );
  revalidatePath('/po-approval');
  revalidatePath('/approvals');
  return done(
    next === 'pending_l2' ? 'Submitted for admin approval.' : 'Submitted for approval.',
  );
}

/** After approval, issue the PO: record the EasyCom PO number that ties to real data. */
export async function issuePoApproval(formData: FormData): Promise<ActionResult> {
  const user = await currentUser();
  if (!user) return fail('Not signed in.');
  if (!canEdit(user.role, 'draft')) {
    return fail('You do not have permission to issue POs.');
  }

  const id = Number(formData.get('id'));
  const easycom = String(formData.get('easycom_po_number') ?? '').trim();
  if (!id) return fail('Invalid PO.');
  if (!easycom) return fail('Enter the EasyCom PO number.');

  const supabase = await supa();
  const { data: updated, error } = await supabase
    .from('sd_po_approval')
    .update({
      easycom_po_number: easycom,
      po_issued_by: user.email,
      po_issued_at: new Date().toISOString(),
    })
    .eq('id', id)
    .eq('status', 'approved')
    .select('id');
  if (error) return fail(error.message);
  if (!updated?.length) return fail('Only an approved PO can be issued.');

  await writeLog(
    'po_approval',
    String(id),
    `PO #${id} issued as ${easycom}`,
    'approved',
    'approved',
    user.email,
    `EasyCom PO ${easycom}`,
  );
  revalidatePath('/po-approval');
  return done(`Issued as EasyCom PO ${easycom}.`);
}

/* ================================================================== */
/* User panel — admin (role manager) assigns roles                     */
/* ================================================================== */

const ASSIGNABLE_ROLES: SdRole[] = ['viewer', 'team', 'admin'];

export async function saveUser(formData: FormData): Promise<ActionResult> {
  const actor = await currentUser();
  if (!actor) return fail('Not signed in.');
  if (actor.role !== 'admin') return fail('Only an admin can manage users.');

  const email = String(formData.get('email') ?? '').trim().toLowerCase();
  const fullName = String(formData.get('full_name') ?? '').trim() || null;
  const role = String(formData.get('role') ?? '') as SdRole;
  const isActive = formData.get('is_active') === 'true';

  if (!/^[^@\s]+@saadaa\.in$/.test(email)) {
    return fail('Enter a valid @saadaa.in email address.');
  }
  if (!ASSIGNABLE_ROLES.includes(role)) return fail('Invalid role.');
  // Guard against locking yourself out of the role manager.
  if (email === actor.email && (role !== 'admin' || !isActive)) {
    return fail('You cannot remove your own admin access.');
  }

  const supabase = await supa();
  const { error } = await supabase
    .from('sd_user')
    .upsert(
      { email, full_name: fullName, role, is_active: isActive },
      { onConflict: 'email' },
    );
  if (error) return fail(`Could not save user: ${error.message}`);

  revalidatePath('/users');
  return done(`Saved ${email}.`);
}
