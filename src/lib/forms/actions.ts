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
import { createAdminClient, hasSupabaseAdminEnv } from '@/lib/supabase/admin';
import { currentUser } from './queries';
import { canApprove, canEdit, canSubmit, statusOnSubmit } from './approval';
import type { ApprovalEntity, PoCategory, PoType, SdRole, SdStatus } from './types';

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
  const planType = String(formData.get('plan_type') ?? 'fg') === 'material' ? 'material' : 'fg';

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
    .eq('plan_type', planType)
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
      .insert({ plan_month: planMonth, plan_type: planType, status: 'draft' })
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
      uom: line.uom ? String(line.uom) : null,
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
/* Vendor capacity — no approval; one live row per vendor, saved singly */
/* ================================================================== */

export async function saveVendorCapacityRow(formData: FormData): Promise<ActionResult> {
  const user = await currentUser();
  if (!user) return fail('Not signed in.');
  if (!canEdit(user.role, 'draft')) {
    return fail('You do not have permission to update vendor capacity.');
  }

  const vendor_code = String(formData.get('vendor_code') ?? '').trim();
  if (!vendor_code) return fail('Vendor code is required.');

  // One current row per vendor: this save overwrites just this vendor's record and
  // re-stamps entry_date, without touching or requiring any other vendor.
  const now = new Date().toISOString();
  const row = {
    vendor_code,
    vendor_name: formData.get('vendor_name') ? String(formData.get('vendor_name')) : null,
    machines_allocated: numOrNull(formData.get('machines_allocated')),
    active_karigar: numOrNull(formData.get('active_karigar')),
    capacity_per_month: numOrNull(formData.get('capacity_per_month')),
    submitted_by: user.email,
    submitted_at: now,
    entry_date: now,
  };

  const supabase = await supa();
  const { error } = await supabase
    .from('sd_vendor_capacity_log')
    .upsert(row, { onConflict: 'vendor_code' });
  if (error) return fail(`Could not save capacity: ${error.message}`);

  revalidatePath('/vendor-capacity');
  return done(`Saved capacity for ${vendor_code}.`);
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

  const rawScope = String(formData.get('scope') ?? 'colour');
  const scope = (['size', 'colour', 'product'].includes(rawScope) ? rawScope : 'colour') as
    | 'size' | 'colour' | 'product';
  const productCode = String(formData.get('product_code') ?? '').trim();
  // Colour/size discontinues need a variant; size needs a size too. A product-level
  // discontinue is the whole product code, no variant.
  const variant =
    scope === 'product' ? null : String(formData.get('product_variant') ?? '').trim() || null;
  const size = scope === 'size' ? String(formData.get('size') ?? '').trim() || null : null;
  const reason = String(formData.get('reason') ?? '').trim();

  if (!productCode) return fail('Pick a product code.');
  if (scope !== 'product' && !variant) return fail('Pick a colour (variant).');
  if (scope === 'size' && !size) return fail('Pick a size to discontinue.');

  const label =
    scope === 'product'
      ? `Product ${productCode}`
      : scope === 'size'
        ? `${productCode} / ${variant} / ${size}`
        : `${productCode} / ${variant}`;

  const supabase = await supa();
  const { data, error } = await supabase
    .from('sd_discontinue_request')
    .insert({
      scope,
      product_code: productCode,
      product_variant: variant,
      size,
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
        ? `A live ${scope}-level request already exists for this.`
        : error.message,
    );
  }

  await writeLog(
    'discontinue',
    String(data.id),
    `Discontinue ${scope} — ${label}`,
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
  standard_cost: 'sd_standard_cost',
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

  // Hard gate: a PO's cost cannot be approved until its TNA critical-path dates are
  // confirmed and locked by the approver (see confirmTna). Rejection is always allowed.
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
  revalidatePath('/standard-cost');
  return done(decision === 'approve' ? 'Approved.' : 'Rejected.');
}

/* ================================================================== */
/* Standard cost sheet                                                 */
/* ================================================================== */

export async function saveStandardCost(formData: FormData): Promise<ActionResult> {
  const user = await currentUser();
  if (!user) return fail('Not signed in.');
  if (!canEdit(user.role, 'draft')) {
    return fail('You do not have permission to edit standard costs.');
  }

  const product_code = String(formData.get('product_code') ?? '').trim();
  if (!product_code) return fail('Product code is required.');

  const supabase = await supa();
  const { data: existing } = await supabase
    .from('sd_standard_cost')
    .select('id, status, frozen')
    .eq('product_code', product_code)
    .maybeSingle();

  if (existing?.frozen) {
    return fail('This cost is frozen (a PO was issued) and can no longer be edited.');
  }
  const status = (existing?.status ?? 'draft') as SdStatus;
  if (!canEdit(user.role, status)) {
    return fail(
      status === 'approved'
        ? 'This cost is approved — resubmit to change it.'
        : 'You cannot edit this cost right now.',
    );
  }

  const patch = {
    product_code,
    job_cost: numOrNull(formData.get('job_cost')),
    fob_cost: numOrNull(formData.get('fob_cost')),
    efob_cost: numOrNull(formData.get('efob_cost')),
    updated_at: new Date().toISOString(),
  };
  const { data, error } = await supabase
    .from('sd_standard_cost')
    .upsert(patch, { onConflict: 'product_code' })
    .select('id')
    .single();
  if (error) return fail(`Could not save: ${error.message}`);

  revalidatePath('/standard-cost');
  return { ok: true, message: `Saved ${product_code}.`, id: data.id as number };
}

export async function submitStandardCost(formData: FormData): Promise<ActionResult> {
  const user = await currentUser();
  if (!user) return fail('Not signed in.');

  const id = Number(formData.get('id'));
  if (!id) return fail('Save the cost before submitting it.');

  const supabase = await supa();
  const { data: row } = await supabase
    .from('sd_standard_cost')
    .select('id, product_code, status, frozen, job_cost, fob_cost, efob_cost')
    .eq('id', id)
    .maybeSingle();
  if (!row) return fail('Cost not found.');
  if (row.frozen) return fail('This cost is frozen and cannot be resubmitted.');
  if (!canSubmit(user.role, row.status as SdStatus)) {
    return fail('This cost cannot be submitted from its current state.');
  }
  if (row.job_cost == null && row.fob_cost == null && row.efob_cost == null) {
    return fail('Enter at least one rate before submitting.');
  }

  const next = statusOnSubmit('standard_cost');
  const { data: updated, error } = await supabase
    .from('sd_standard_cost')
    .update({
      status: next,
      submitted_by: user.email,
      submitted_at: new Date().toISOString(),
      rejection_notes: null,
    })
    .eq('id', id)
    .eq('status', 'draft')
    .select('id');
  if (error) return fail(error.message);
  if (!updated?.length) return fail('Already submitted by someone else.');

  await writeLog(
    'standard_cost',
    String(id),
    `Standard cost — ${row.product_code}`,
    'draft',
    next,
    user.email,
  );
  revalidatePath('/standard-cost');
  revalidatePath('/approvals');
  return done('Submitted for approval.');
}

/* ================================================================== */
/* PO Approval                                                         */
/* ================================================================== */

const PO_TYPES: PoType[] = ['FOB', 'job_work', 'efob'];
const PO_CATEGORIES: PoCategory[] = ['fg', 'mat', 'npd'];
const dateOrNull = (v: unknown) =>
  /^\d{4}-\d{2}-\d{2}$/.test(String(v ?? '')) ? String(v) : null;
const textOrNull = (v: unknown) => {
  const s = String(v ?? '').trim();
  return s || null;
};

/** Read the PO Approval input fields out of a FormData into a table row. */
function readPoFields(formData: FormData) {
  const rawType = String(formData.get('po_type') ?? '');
  const rawCat = String(formData.get('category') ?? 'fg').toLowerCase();
  return {
    po_type: (PO_TYPES.includes(rawType as PoType) ? rawType : null) as PoType | null,
    product_code: textOrNull(formData.get('product_code')),
    po_ref_num: textOrNull(formData.get('po_ref_num')),
    vendor_code: textOrNull(formData.get('vendor_code')),
    vendor_name: textOrNull(formData.get('vendor_name')),
    tna_sheet_url: textOrNull(formData.get('tna_sheet_url')),
    cost_sheet_url: textOrNull(formData.get('cost_sheet_url')),
    po_qty: Number(formData.get('po_qty') ?? 0) || 0,
    po_closing_date: dateOrNull(formData.get('po_closing_date')),
    cad_folder_url: textOrNull(formData.get('cad_folder_url')),
    cs_pp_sample_due: dateOrNull(formData.get('cs_pp_sample_due')),
    cs_gpt_due: dateOrNull(formData.get('cs_gpt_due')),
    cs_cutting_start: dateOrNull(formData.get('cs_cutting_start')),
    cs_inline_qc_due: dateOrNull(formData.get('cs_inline_qc_due')),
    critical_path_first_delivery: dateOrNull(formData.get('critical_path_first_delivery')),
    trim_card_signed: formData.get('trim_card_signed') === 'true',
    buying_plan_no: textOrNull(formData.get('buying_plan_no')),
    category: (PO_CATEGORIES.includes(rawCat as PoCategory) ? rawCat : 'fg') as PoCategory,
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

  if (id) {
    const { error } = await supabase
      .from('sd_po_approval')
      .update(fields)
      .eq('id', id)
      .eq('status', 'draft');
    if (error) return fail(`Could not save: ${error.message}`);
    revalidatePath('/po-approval');
    return { ok: true, message: 'Saved.', id };
  }

  const { data, error } = await supabase
    .from('sd_po_approval')
    .insert({ ...fields, created_by: user.email, status: 'draft' })
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
    .select('id, status, po_ref_num, category, product_code, po_qty')
    .eq('id', id)
    .maybeSingle();
  if (!po) return fail('PO not found.');
  if (!canSubmit(user.role, po.status as SdStatus)) {
    return fail('This PO cannot be submitted from its current state.');
  }
  const qty = Number(po.po_qty || 0);
  if (qty <= 0) return fail('Enter a quantity before submitting.');

  const next = statusOnSubmit('po_approval', qty, po.category as string);
  const { data: updated, error } = await supabase
    .from('sd_po_approval')
    .update({
      status: next,
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
    `PO ${po.po_ref_num ?? `#${id}`} · ${po.category} · ${po.product_code ?? ''}`.trim(),
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

/**
 * After approval, issue + sign the PO. Captures the EasyCom mapping key (which
 * ties to sd_po_master_raw) plus the DiGiO-signed docs, sign date, and first
 * actual delivery date (fields 19–25). The DiGiO fields are manual URLs for now
 * — the API integration populates them later. Callable repeatedly to add the
 * signed docs after the initial issuance.
 */
export async function issuePoApproval(formData: FormData): Promise<ActionResult> {
  const user = await currentUser();
  if (!user) return fail('Not signed in.');
  if (!canEdit(user.role, 'draft')) {
    return fail('You do not have permission to issue POs.');
  }

  const id = Number(formData.get('id'));
  if (!id) return fail('Invalid PO.');
  const easycom = String(formData.get('easycom_po_no') ?? '').trim();

  const supabase = await supa();
  const { data: po } = await supabase
    .from('sd_po_approval')
    .select('id, status, product_code, po_issued_at')
    .eq('id', id)
    .maybeSingle();
  if (!po) return fail('PO not found.');
  if (po.status !== 'approved') return fail('Only an approved PO can be issued.');

  const alreadyIssued = Boolean(po.po_issued_at);
  // The EasyCom number is required to first issue; once issued it can be edited.
  if (!alreadyIssued && !easycom) return fail('Enter the EasyCom PO number to issue.');

  // Explicit lock-in: the standard cost is frozen as the benchmark ONLY when the
  // issuer ticks "set as standard benchmark cost" — never silently on first issue.
  const setBenchmark = formData.get('set_benchmark') === 'true';

  const patch: Record<string, unknown> = {
    signed_po_document_url: textOrNull(formData.get('signed_po_document_url')),
    signed_cost_sheet_url: textOrNull(formData.get('signed_cost_sheet_url')),
    signed_tna_url: textOrNull(formData.get('signed_tna_url')),
    signed_po_ref_number: textOrNull(formData.get('signed_po_ref_number')),
    date_of_po_sign: dateOrNull(formData.get('date_of_po_sign')),
    first_actual_delivery_date: dateOrNull(formData.get('first_actual_delivery_date')),
  };
  if (easycom) patch.easycom_po_no = easycom;
  if (!alreadyIssued) patch.po_issued_at = new Date().toISOString();
  if (setBenchmark) patch.benchmark_cost = true;

  const { data: updated, error } = await supabase
    .from('sd_po_approval')
    .update(patch)
    .eq('id', id)
    .eq('status', 'approved')
    .select('id');
  if (error) return fail(error.message);
  if (!updated?.length) return fail('Only an approved PO can be issued.');

  // Freeze the product's standard cost as the benchmark — only when explicitly set.
  if (setBenchmark) {
    const productCode = (po.product_code as string | null)?.trim();
    if (productCode) {
      await supabase
        .from('sd_standard_cost')
        .update({ frozen: true, frozen_at: new Date().toISOString() })
        .eq('product_code', productCode)
        .eq('frozen', false);
    }
  }

  if (!alreadyIssued) {
    await writeLog(
      'po_approval',
      String(id),
      `PO #${id} issued as ${easycom}`,
      'approved',
      'approved',
      user.email,
      `EasyCom PO ${easycom}`,
    );
  }
  revalidatePath('/po-approval');
  revalidatePath('/standard-cost');
  return done(alreadyIssued ? 'Signing details saved.' : `Issued as EasyCom PO ${easycom}.`);
}

/**
 * Approver-only: review and LOCK the PO's TNA critical-path dates. Only whoever can
 * approve this PO (team for FG ≤5,000; admin for >5,000 / NPD / MAT) may enter or
 * confirm them. decideApproval hard-blocks the cost decision until this has run, so a
 * PO with a nonsensical delivery window can't get its cost approved unchecked.
 */
export async function confirmTna(formData: FormData): Promise<ActionResult> {
  const user = await currentUser();
  if (!user) return fail('Not signed in.');

  const id = Number(formData.get('id'));
  if (!id) return fail('Invalid PO.');

  const supabase = await supa();
  const { data: po } = await supabase
    .from('sd_po_approval')
    .select('id, status, po_ref_num')
    .eq('id', id)
    .maybeSingle();
  if (!po) return fail('PO not found.');

  const status = po.status as SdStatus;
  if (!canApprove(user.role, status)) {
    return fail('Only this PO’s approver can confirm its TNA dates.');
  }

  const now = new Date().toISOString();
  const { data: updated, error } = await supabase
    .from('sd_po_approval')
    .update({
      po_closing_date: dateOrNull(formData.get('po_closing_date')),
      cs_pp_sample_due: dateOrNull(formData.get('cs_pp_sample_due')),
      cs_gpt_due: dateOrNull(formData.get('cs_gpt_due')),
      cs_cutting_start: dateOrNull(formData.get('cs_cutting_start')),
      cs_inline_qc_due: dateOrNull(formData.get('cs_inline_qc_due')),
      critical_path_first_delivery: dateOrNull(formData.get('critical_path_first_delivery')),
      tna_confirmed: true,
      tna_confirmed_by: user.email,
      tna_confirmed_at: now,
    })
    .eq('id', id)
    .eq('status', status)
    .select('id');
  if (error) return fail(error.message);
  if (!updated?.length) return fail('This PO changed state — reload and try again.');

  await writeLog(
    'po_approval',
    String(id),
    `PO ${po.po_ref_num ?? `#${id}`} · TNA confirmed`,
    status,
    status,
    user.email,
    'TNA dates confirmed',
  );
  revalidatePath('/po-approval');
  return done('TNA dates confirmed — cost approval is now unblocked.');
}

/* ================================================================== */
/* Product master — status + woven/knitted, read by the Buying Plan    */
/* ================================================================== */

const PRODUCT_STATUSES = [
  'Active', 'Inactive', 'TBD', 'NPD', 'NPD-Not-Launched', 'Ongoing', 'Discontinued',
];
const FABRIC_TYPES = ['Woven', 'Knitted'];

export async function saveProductMaster(formData: FormData): Promise<ActionResult> {
  const user = await currentUser();
  if (!user) return fail('Not signed in.');
  if (!canEdit(user.role, 'draft')) {
    return fail('You do not have permission to edit the product master.');
  }

  const product_code = String(formData.get('product_code') ?? '').trim();
  if (!product_code) return fail('Product code is required.');

  const rawStatus = String(formData.get('product_status') ?? '').trim();
  const rawFabric = String(formData.get('fabric_type') ?? '').trim();
  const product_status = PRODUCT_STATUSES.includes(rawStatus) ? rawStatus : null;
  const fabric_type = FABRIC_TYPES.includes(rawFabric) ? rawFabric : null;
  const is_active = formData.get('is_active') !== 'false';

  const supabase = await supa();
  const { error } = await supabase.from('sd_product_master').upsert(
    {
      product_code,
      product_status,
      fabric_type,
      is_active,
      updated_at: new Date().toISOString(),
    },
    { onConflict: 'product_code' },
  );
  if (error) return fail(`Could not save: ${error.message}`);

  revalidatePath('/product-master');
  revalidatePath('/buying-plan');
  return done(`Saved ${product_code}.`);
}

/** FG-master auto-rule action: promote an NPD-not-launched product to NPD. */
export async function promoteToNpd(formData: FormData): Promise<ActionResult> {
  const user = await currentUser();
  if (!user) return fail('Not signed in.');
  if (!canEdit(user.role, 'draft')) {
    return fail('You do not have permission to change product status.');
  }
  const product_code = String(formData.get('product_code') ?? '').trim();
  if (!product_code) return fail('Product code is required.');

  const supabase = await supa();
  // Upsert only the status — fabric_type on an existing row is preserved.
  const { error } = await supabase
    .from('sd_product_master')
    .upsert(
      { product_code, product_status: 'NPD', updated_at: new Date().toISOString() },
      { onConflict: 'product_code' },
    );
  if (error) return fail(`Could not promote: ${error.message}`);
  revalidatePath('/product-master');
  revalidatePath('/buying-plan');
  return done(`${product_code} promoted to NPD.`);
}

/* ================================================================== */
/* Fabric master — manual code + composition, duplicate-blocked        */
/* ================================================================== */

function readFabricFields(formData: FormData) {
  return {
    composition: textOrNull(formData.get('composition')),
    warp_count: textOrNull(formData.get('warp_count')),
    weft_count: textOrNull(formData.get('weft_count')),
    third_thread: textOrNull(formData.get('third_thread')),
    weave: textOrNull(formData.get('weave')),
    gsm: numOrNull(formData.get('gsm')),
    raw_material_color: textOrNull(formData.get('raw_material_color')),
    fabric_name: textOrNull(formData.get('fabric_name')),
    is_active: formData.get('is_active') !== 'false',
    updated_at: new Date().toISOString(),
  };
}

/** Add a NEW fabric code. Insert-only so an existing code is blocked (the point). */
export async function addFabric(formData: FormData): Promise<ActionResult> {
  const user = await currentUser();
  if (!user) return fail('Not signed in.');
  if (!canEdit(user.role, 'draft')) {
    return fail('You do not have permission to edit the fabric master.');
  }
  const fabric_code = String(formData.get('fabric_code') ?? '').trim().toUpperCase();
  if (!fabric_code) return fail('Fabric code is required.');

  const supabase = await supa();
  const { error } = await supabase
    .from('sd_fabric_master')
    .insert({ fabric_code, ...readFabricFields(formData) });
  if (error) {
    return fail(
      error.code === '23505'
        ? `Fabric code “${fabric_code}” already exists — use a different code.`
        : `Could not add: ${error.message}`,
    );
  }
  revalidatePath('/fabric-master');
  revalidatePath('/buying-plan');
  return done(`Added ${fabric_code}.`);
}

/** Update an existing fabric code's fields (code itself is the key, never changed). */
export async function updateFabric(formData: FormData): Promise<ActionResult> {
  const user = await currentUser();
  if (!user) return fail('Not signed in.');
  if (!canEdit(user.role, 'draft')) {
    return fail('You do not have permission to edit the fabric master.');
  }
  const fabric_code = String(formData.get('fabric_code') ?? '').trim().toUpperCase();
  if (!fabric_code) return fail('Fabric code is required.');

  const supabase = await supa();
  const { data: updated, error } = await supabase
    .from('sd_fabric_master')
    .update(readFabricFields(formData))
    .eq('fabric_code', fabric_code)
    .select('fabric_code');
  if (error) return fail(`Could not save: ${error.message}`);
  if (!updated?.length) return fail('Fabric code not found.');
  revalidatePath('/fabric-master');
  revalidatePath('/buying-plan');
  return done(`Saved ${fabric_code}.`);
}

/* ================================================================== */
/* Receivable Plan — weekly inputs (no approval)                       */
/* ================================================================== */

export async function saveReceivableInput(formData: FormData): Promise<ActionResult> {
  const user = await currentUser();
  if (!user) return fail('Not signed in.');
  if (!canEdit(user.role, 'draft')) {
    return fail('You do not have permission to edit the receivable plan.');
  }
  const row_key = String(formData.get('row_key') ?? '').trim();
  if (!row_key) return fail('Invalid row.');
  const [po_number, product_variant] = row_key.split('|');

  const supabase = await supa();
  const { error } = await supabase.from('sd_receivable_input').upsert(
    {
      row_key,
      po_number: po_number ?? null,
      product_variant: product_variant ?? null,
      delivery_date_this_week: dateOrNull(formData.get('delivery_date_this_week')),
      qty_expected_this_week: numOrNull(formData.get('qty_expected_this_week')),
      remarks: textOrNull(formData.get('remarks')),
      updated_by: user.email,
      updated_at: new Date().toISOString(),
    },
    { onConflict: 'row_key' },
  );
  if (error) return fail(`Could not save: ${error.message}`);
  revalidatePath('/receivable-plan');
  return done('Saved.');
}

/* ================================================================== */
/* Cash flow — vendor payment terms (drives the forecast)              */
/* ================================================================== */

export async function saveVendorTerms(formData: FormData): Promise<ActionResult> {
  const user = await currentUser();
  if (!user) return fail('Not signed in.');
  if (!canEdit(user.role, 'draft')) {
    return fail('You do not have permission to edit vendor terms.');
  }
  const vendor_code = String(formData.get('vendor_code') ?? '').trim();
  const days = Number(formData.get('payment_terms_days'));
  if (!vendor_code) return fail('Invalid vendor.');
  if (!Number.isFinite(days) || days < 0) return fail('Enter a valid number of days.');

  const supabase = await supa();
  const { error } = await supabase.from('sd_vendor_payment_terms').upsert(
    {
      vendor_code,
      payment_terms_days: Math.round(days),
      updated_by: user.email,
      updated_at: new Date().toISOString(),
    },
    { onConflict: 'vendor_code' },
  );
  if (error) return fail(`Could not save: ${error.message}`);
  revalidatePath('/cash-flow');
  return done(`Saved ${vendor_code} → ${Math.round(days)} days.`);
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

/**
 * Create (or reset) an email+password login for a user, then provision their
 * role. Admin-only. Uses the service-role Admin API (the publishable key cannot
 * create auth users); the sd_user role row is still written with the actor's
 * JWT so RLS applies. Domain is enforced here since the auth.users trigger is
 * absent on this project.
 */
export async function createUserLogin(formData: FormData): Promise<ActionResult> {
  const actor = await currentUser();
  if (!actor) return fail('Not signed in.');
  if (actor.role !== 'admin') return fail('Only an admin can manage users.');

  const email = String(formData.get('email') ?? '').trim().toLowerCase();
  const fullName = String(formData.get('full_name') ?? '').trim() || null;
  const role = String(formData.get('role') ?? '') as SdRole;
  const isActive = formData.get('is_active') === 'true';
  const password = String(formData.get('password') ?? '');

  if (!/^[^@s]+@saadaa.in$/.test(email)) return fail('Enter a valid @saadaa.in email address.');
  if (!ASSIGNABLE_ROLES.includes(role)) return fail('Invalid role.');
  if (password.length < 8) return fail('Password must be at least 8 characters.');
  if (!hasSupabaseAdminEnv()) {
    return fail('SUPABASE_SERVICE_ROLE_KEY is not set on the server, so login accounts cannot be created.');
  }

  const admin = createAdminClient();
  // Pre-confirm the email so the user can sign in immediately with the password.
  const { error: createErr } = await admin.auth.admin.createUser({
    email,
    password,
    email_confirm: true,
    user_metadata: fullName ? { full_name: fullName } : undefined,
  });
  if (createErr) {
    // Already registered -> treat as a password reset for the existing account.
    const existing = await findAuthUserByEmail(email);
    if (!existing) return fail(`Could not create login: ${createErr.message}`);
    const { error: updErr } = await admin.auth.admin.updateUserById(existing.id, { password });
    if (updErr) return fail(`Could not set password: ${updErr.message}`);
  }

  // Provision/refresh the role row with the actor's JWT (RLS: admin manage users).
  const supabase = await supa();
  const { error: roleErr } = await supabase
    .from('sd_user')
    .upsert({ email, full_name: fullName, role, is_active: isActive }, { onConflict: 'email' });
  if (roleErr) return fail(`Login created, but saving the role failed: ${roleErr.message}`);

  revalidatePath('/users');
  return done(`${createErr ? 'Reset password for' : 'Created login for'} ${email}.`);
}

// Find an existing auth user by email (paginated; the user base is small).
async function findAuthUserByEmail(email: string) {
  const admin = createAdminClient();
  const target = email.toLowerCase();
  for (let page = 1; ; page += 1) {
    const { data, error } = await admin.auth.admin.listUsers({ page, perPage: 1000 });
    const users = data?.users ?? [];
    if (error || !users.length) return null;
    const found = users.find((u) => (u.email ?? '').toLowerCase() === target);
    if (found) return found;
    if (users.length < 1000) return null;
  }
}
