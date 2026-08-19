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
import {
  canConfirmCm,
  canConfirmFabric,
  canPropose,
  canRejectCost,
  canRenegotiate,
  canSetTarget,
  canSignOff,
  canSubmitRate,
} from './cost';
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
  // document that is edited as a whole sheet. But we first snapshot the current
  // per-line approval state so a rework round-trip doesn't wipe it: a line whose
  // product_code and all three quantities are unchanged keeps its line_status
  // (so an already-approved Woven line stays approved while the planner fixes the
  // Knitted lines). Any changed or new line resets to pending (null).
  const { data: prior } = await supabase
    .from('sd_buying_plan_line')
    .select('product_code, job_work_qty, fob_qty, efob_qty, line_status, rework_notes')
    .eq('plan_id', planId);
  const priorByCode = new Map<
    string,
    { job: number; fob: number; efob: number; line_status: SdStatus | null; rework_notes: string | null }
  >();
  for (const p of (prior ?? []) as Record<string, unknown>[]) {
    priorByCode.set(String(p.product_code), {
      job: Number(p.job_work_qty || 0),
      fob: Number(p.fob_qty || 0),
      efob: Number(p.efob_qty || 0),
      line_status: (p.line_status ?? null) as SdStatus | null,
      rework_notes: (p.rework_notes ?? null) as string | null,
    });
  }

  const { error: delError } = await supabase
    .from('sd_buying_plan_line')
    .delete()
    .eq('plan_id', planId);
  if (delError) return fail(`Could not clear old lines: ${delError.message}`);

  const payload = lines
    .filter((line) => String(line.product_code ?? '').trim())
    .map((line) => {
      const code = String(line.product_code).trim();
      const job = Number(line.job_work_qty ?? 0) || 0;
      const fob = Number(line.fob_qty ?? 0) || 0;
      const efob = Number(line.efob_qty ?? 0) || 0;
      const before = priorByCode.get(code);
      const unchanged =
        before && before.job === job && before.fob === fob && before.efob === efob;
      return {
        plan_id: planId,
        product_code: code,
        product_status: line.product_status ? String(line.product_status) : null,
        fabric_type: line.fabric_type ? String(line.fabric_type) : null,
        pending_quantity:
          line.pending_quantity === '' || line.pending_quantity == null
            ? null
            : Number(line.pending_quantity),
        job_work_qty: job,
        fob_qty: fob,
        efob_qty: efob,
        standard_value:
          line.standard_value === '' || line.standard_value == null
            ? null
            : Number(line.standard_value),
        uom: line.uom ? String(line.uom) : null,
        line_status: unchanged ? before!.line_status : null,
        rework_notes: unchanged ? before!.rework_notes : null,
        // Material track only (FG leaves these null): Job-Work rate, free remark,
        // and which material type (raw/dyed/trim) the line belongs to.
        job_rate:
          line.job_rate === '' || line.job_rate == null ? null : Number(line.job_rate),
        remark: line.remark ? String(line.remark) : null,
        material_type: line.material_type ? String(line.material_type) : null,
        colour: line.colour ? String(line.colour) : null,
      };
    });

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
    .select('id, job_work_qty, fob_qty, efob_qty, line_status')
    .eq('plan_id', planId);
  const lineRows = (lines ?? []) as {
    id: number;
    job_work_qty: number;
    fob_qty: number;
    efob_qty: number;
    line_status: SdStatus | null;
  }[];
  const qty = lineRows.reduce(
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
    .in('status', ['draft', 'rework'])
    .select('id');
  if (error) return fail(error.message);
  if (!updated?.length) return fail('Already submitted by someone else.');

  // Per-line approval set: only non-zero lines need a decision, and any line
  // already approved (preserved across a rework) stays approved. Zero-qty lines
  // are cleared so partial/blank rows never sit in the approver's queue.
  const toPending: number[] = [];
  const toClear: number[] = [];
  for (const l of lineRows) {
    const lineQty = Number(l.job_work_qty || 0) + Number(l.fob_qty || 0) + Number(l.efob_qty || 0);
    if (lineQty <= 0) toClear.push(l.id);
    else if (l.line_status !== 'approved') toPending.push(l.id);
  }
  if (toPending.length) {
    await supabase.from('sd_buying_plan_line').update({ line_status: next, rework_notes: null }).in('id', toPending);
  }
  if (toClear.length) {
    await supabase.from('sd_buying_plan_line').update({ line_status: null, rework_notes: null }).in('id', toClear);
  }

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

/**
 * Line-item approval for a Buying Plan: the approver ticks the lines they're
 * happy with and approves them in one action (multi-select). The header stays
 * "Approval Pending" until EVERY non-zero line is approved, then flips to
 * approved. Lines needing re-evaluation go back separately via reworkLines, so
 * the Woven portion can be approved while the Knitted portion is still reviewed.
 */
export async function approveBuyingPlanLines(formData: FormData): Promise<ActionResult> {
  const user = await currentUser();
  if (!user) return fail('Not signed in.');
  const planId = Number(formData.get('plan_id'));
  if (!planId) return fail('Invalid plan.');
  let lineIds: number[] = [];
  try {
    lineIds = (JSON.parse(String(formData.get('line_ids') ?? '[]')) as unknown[])
      .map((v) => Number(v))
      .filter((n) => Number.isFinite(n) && n > 0);
  } catch {
    lineIds = [];
  }
  if (!lineIds.length) return fail('Select at least one line to approve.');

  const supabase = await supa();
  const { data: plan } = await supabase
    .from('sd_buying_plan')
    .select('id, plan_month, status')
    .eq('id', planId)
    .maybeSingle();
  if (!plan) return fail('Plan not found.');
  const from = plan.status as SdStatus;
  if (!canApprove(user.role, from)) return fail('This decision is above your approval level.');

  // Approve the selected lines, scoped to this plan as a safety measure.
  const { error: lineErr } = await supabase
    .from('sd_buying_plan_line')
    .update({ line_status: 'approved', rework_notes: null })
    .eq('plan_id', planId)
    .in('id', lineIds);
  if (lineErr) return fail(lineErr.message);

  // Re-read every line to decide the header: it flips to approved only once all
  // non-zero lines are approved.
  const { data: allLines } = await supabase
    .from('sd_buying_plan_line')
    .select('job_work_qty, fob_qty, efob_qty, line_status')
    .eq('plan_id', planId);
  const nonZero = ((allLines ?? []) as Record<string, unknown>[]).filter(
    (l) => Number(l.job_work_qty || 0) + Number(l.fob_qty || 0) + Number(l.efob_qty || 0) > 0,
  );
  const stillPending = nonZero.filter((l) => l.line_status !== 'approved').length;
  const label = `Buying plan ${String(plan.plan_month).slice(0, 7)}`;

  if (nonZero.length > 0 && stillPending === 0) {
    const { data: hdr, error: hdrErr } = await supabase
      .from('sd_buying_plan')
      .update({ status: 'approved', approved_by: user.email, approved_at: new Date().toISOString() })
      .eq('id', planId)
      .eq('status', from)
      .select('id');
    if (hdrErr) return fail(hdrErr.message);
    if (hdr?.length) {
      await writeLog('buying_plan', String(planId), label, from, 'approved', user.email, 'All lines approved');
    }
    revalidatePath('/approvals');
    revalidatePath('/buying-plan');
    return done(`Approved ${lineIds.length} line(s) — plan fully approved.`);
  }

  await writeLog('buying_plan', String(planId), label, from, from, user.email, `${lineIds.length} line(s) approved`);
  revalidatePath('/approvals');
  revalidatePath('/buying-plan');
  return done(`Approved ${lineIds.length} line(s); ${stillPending} still pending.`);
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
  // Capacity/month feeds the PO Approval vendor headroom tab (main page + queue).
  revalidatePath('/po-approval');
  revalidatePath('/approvals');
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
  material_cost: 'sd_material_standard_cost',
  receivable_plan: 'sd_receivable_input',
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
export async function submitReceivablePlan(): Promise<ActionResult> {
  const user = await currentUser();
  if (!user) return fail('Not signed in.');
  if (!canSubmit(user.role, 'draft')) return fail('You do not have permission to submit.');
  const now = new Date().toISOString();
  const supabase = await supa();
  const { data, error } = await supabase
    .from('sd_receivable_input')
    .update({ status: 'submitted', submitted_by: user.email, submitted_at: now })
    .eq('status', 'draft')
    .select('row_key');
  if (error) return fail(error.message);
  revalidatePath('/receivable-plan');
  revalidatePath('/approvals');
  return done(`Submitted ${data?.length ?? 0} row(s) for approval.`);
}

/**
 * Replace a PO's colour/size line items (sd_po_approval_line). Editable while the
 * PO is not yet approved — this is what makes PO line-item rework actionable.
 */
export async function savePoLines(formData: FormData): Promise<ActionResult> {
  const user = await currentUser();
  if (!user) return fail('Not signed in.');
  if (!canEdit(user.role, 'draft')) return fail('You do not have permission to edit PO lines.');
  const poId = Number(formData.get('po_id'));
  if (!poId) return fail('Invalid PO.');
  let lines: { product_variant?: string; size?: string; qty?: number }[] = [];
  try {
    lines = JSON.parse(String(formData.get('lines') ?? '[]'));
  } catch {
    lines = [];
  }
  const clean = lines
    .map((l) => ({
      product_variant: String(l.product_variant ?? '').trim() || null,
      size: String(l.size ?? '').trim() || null,
      qty: Number(l.qty) || 0,
    }))
    .filter((l) => l.product_variant || l.qty);
  const supabase = await supa();
  const { data: po } = await supabase.from('sd_po_approval').select('status').eq('id', poId).maybeSingle();
  if (!po) return fail('PO not found.');
  if (po.status === 'approved') return fail('An approved PO cannot have its lines changed.');
  await supabase.from('sd_po_approval_line').delete().eq('po_id', poId);
  if (clean.length) {
    const { error } = await supabase
      .from('sd_po_approval_line')
      .insert(clean.map((l) => ({ po_id: poId, ...l })));
    if (error) return fail(error.message);
  }
  // PO qty is the sum of the size lines — never typed by hand.
  const poQty = clean.reduce((sum, l) => sum + (Number(l.qty) || 0), 0);
  await supabase.from('sd_po_approval').update({ po_qty: poQty }).eq('id', poId);
  revalidatePath('/po-approval');
  revalidatePath('/approvals');
  return done(`Saved ${clean.length} line(s) · PO qty ${poQty}.`);
}

/** Row-wise PO closure (Yes/No) on the submission/closure table. */
export async function setPoClosure(formData: FormData): Promise<ActionResult> {
  const user = await currentUser();
  if (!user) return fail('Not signed in.');
  if (!canEdit(user.role, 'draft')) return fail('You do not have permission to close POs.');
  const po_number = String(formData.get('po_number') ?? '').trim();
  if (!po_number) return fail('Invalid PO.');
  const decision = String(formData.get('decision') ?? '');
  const status: SdStatus = decision === 'yes' ? 'approved' : decision === 'no' ? 'rejected' : 'draft';

  const supabase = await supa();
  const { error } = await supabase.from('sd_po_closure').upsert(
    {
      po_number,
      status,
      decided_by: user.email,
      decided_at: new Date().toISOString(),
      note: textOrNull(formData.get('note')),
      updated_at: new Date().toISOString(),
    },
    { onConflict: 'po_number' },
  );
  if (error) return fail(`Could not save: ${error.message}`);
  revalidatePath('/po-approval');
  return done(status === 'approved' ? 'PO marked closed.' : status === 'rejected' ? 'PO flagged.' : 'Saved.');
}

/** Standard TNA lead-times (singleton) — the offsets that auto-generate the critical path. */
export async function saveTnaLeadtimes(formData: FormData): Promise<ActionResult> {
  const user = await currentUser();
  if (!user) return fail('Not signed in.');
  if (!canEdit(user.role, 'draft')) return fail('You do not have permission to edit TNA lead-times.');
  const intOrNull = (v: FormDataEntryValue | null) => {
    const n = Number(v);
    return v == null || String(v).trim() === '' || !Number.isFinite(n) ? null : Math.round(n);
  };
  const supabase = await supa();
  const { error } = await supabase.from('sd_tna_leadtimes').upsert(
    {
      id: 1,
      pp_sample_days: intOrNull(formData.get('pp_sample_days')),
      gpt_days: intOrNull(formData.get('gpt_days')),
      cutting_days: intOrNull(formData.get('cutting_days')),
      inline_qc_days: intOrNull(formData.get('inline_qc_days')),
      first_delivery_days: intOrNull(formData.get('first_delivery_days')),
      po_closing_days: intOrNull(formData.get('po_closing_days')),
      updated_by: user.email,
      updated_at: new Date().toISOString(),
    },
    { onConflict: 'id' },
  );
  if (error) return fail(`Could not save: ${error.message}`);
  revalidatePath('/po-approval');
  return done('TNA lead-times saved.');
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
    cm_cost: numOrNull(formData.get('cm_cost')),
    total_po_avg_cost: numOrNull(formData.get('total_po_avg_cost')),
    cad_link: textOrNull(formData.get('cad_link')),
    rfp_link: textOrNull(formData.get('rfp_link')),
    fabric_code: textOrNull(formData.get('fabric_code')),
    // Saving is the act of documenting — clears the "data gap" flag.
    documented: true,
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

/**
 * Replace the colour/size cost detail lines for one product (the expandable
 * "actual standard cost" the approver reviews). Marks the product documented.
 */
export async function saveStandardCostLines(formData: FormData): Promise<ActionResult> {
  const user = await currentUser();
  if (!user) return fail('Not signed in.');
  if (!canEdit(user.role, 'draft')) {
    return fail('You do not have permission to edit standard costs.');
  }
  const product_code = String(formData.get('product_code') ?? '').trim();
  if (!product_code) return fail('Product code is required.');

  let lines: { colour?: string; size?: string; fabric_cost?: unknown; cm_cost?: unknown; total_cost?: unknown }[] = [];
  try {
    lines = JSON.parse(String(formData.get('lines') ?? '[]'));
  } catch {
    lines = [];
  }

  const supabase = await supa();
  const { data: parent } = await supabase
    .from('sd_standard_cost')
    .select('id, frozen')
    .eq('product_code', product_code)
    .maybeSingle();
  if (parent?.frozen) return fail('This cost is frozen and can no longer be edited.');

  const clean = lines
    .map((l) => ({
      product_code,
      colour: textOrNull(l.colour),
      size: textOrNull(l.size),
      fabric_cost: numOrNull(l.fabric_cost),
      cm_cost: numOrNull(l.cm_cost),
      total_cost: numOrNull(l.total_cost),
    }))
    .filter((l) => l.colour || l.size || l.fabric_cost != null || l.cm_cost != null || l.total_cost != null);

  // Replace strategy: clear the product's lines, then insert the current set.
  await supabase.from('sd_standard_cost_line').delete().eq('product_code', product_code);
  if (clean.length) {
    const { error } = await supabase.from('sd_standard_cost_line').insert(clean);
    if (error) return fail(`Could not save lines: ${error.message}`);
  }
  // Ensure a parent row exists and is marked documented.
  await supabase
    .from('sd_standard_cost')
    .upsert(
      { product_code, documented: true, updated_at: new Date().toISOString() },
      { onConflict: 'product_code' },
    );

  revalidatePath('/standard-cost');
  return done(`Saved ${clean.length} cost line(s) for ${product_code}.`);
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
    .in('status', ['draft', 'rework'])
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

/* ------------------------------------------------------------------ */
/* Material standard cost — parallel sheet for raw/dyed/trim materials  */
/* ------------------------------------------------------------------ */

export async function saveMaterialCost(formData: FormData): Promise<ActionResult> {
  const user = await currentUser();
  if (!user) return fail('Not signed in.');
  if (!canEdit(user.role, 'draft')) {
    return fail('You do not have permission to edit material costs.');
  }

  const product_code = String(formData.get('product_code') ?? '').trim().toUpperCase();
  if (!product_code) return fail('Material code is required.');

  const supabase = await supa();
  const { data: existing } = await supabase
    .from('sd_material_standard_cost')
    .select('id, status, frozen')
    .eq('product_code', product_code)
    .maybeSingle();

  if (existing?.frozen) {
    return fail('This cost is frozen and can no longer be edited.');
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
    updated_at: new Date().toISOString(),
  };
  const { data, error } = await supabase
    .from('sd_material_standard_cost')
    .upsert(patch, { onConflict: 'product_code' })
    .select('id')
    .single();
  if (error) return fail(`Could not save: ${error.message}`);

  revalidatePath('/standard-cost');
  revalidatePath('/buying-plan');
  return { ok: true, message: `Saved ${product_code}.`, id: data.id as number };
}

export async function submitMaterialCost(formData: FormData): Promise<ActionResult> {
  const user = await currentUser();
  if (!user) return fail('Not signed in.');

  const id = Number(formData.get('id'));
  if (!id) return fail('Save the cost before submitting it.');

  const supabase = await supa();
  const { data: row } = await supabase
    .from('sd_material_standard_cost')
    .select('id, product_code, status, frozen, job_cost, fob_cost')
    .eq('id', id)
    .maybeSingle();
  if (!row) return fail('Cost not found.');
  if (row.frozen) return fail('This cost is frozen and cannot be resubmitted.');
  if (!canSubmit(user.role, row.status as SdStatus)) {
    return fail('This cost cannot be submitted from its current state.');
  }
  if (row.job_cost == null && row.fob_cost == null) {
    return fail('Enter a Job Work or Purchase rate before submitting.');
  }

  const next = statusOnSubmit('material_cost');
  const { data: updated, error } = await supabase
    .from('sd_material_standard_cost')
    .update({
      status: next,
      submitted_by: user.email,
      submitted_at: new Date().toISOString(),
      rejection_notes: null,
    })
    .eq('id', id)
    .in('status', ['draft', 'rework'])
    .select('id');
  if (error) return fail(error.message);
  if (!updated?.length) return fail('Already submitted by someone else.');

  await writeLog(
    'material_cost',
    String(id),
    `Material cost — ${row.product_code}`,
    'draft',
    next,
    user.email,
  );
  revalidatePath('/standard-cost');
  revalidatePath('/approvals');
  return done('Submitted for approval.');
}

/* ------------------------------------------------------------------ */
/* Cost negotiation — its own process (propose → target → actual →     */
/* sign-off), on either the FG or the material cost sheet.             */
/* ------------------------------------------------------------------ */

type CostTrack = 'fg' | 'material';
const COST_TABLE: Record<CostTrack, string> = {
  fg: 'sd_standard_cost',
  material: 'sd_material_standard_cost',
};
const costTrackOf = (fd: FormData): CostTrack =>
  String(fd.get('track') ?? 'fg') === 'material' ? 'material' : 'fg';
const costEntity = (t: CostTrack): ApprovalEntity =>
  t === 'material' ? 'material_cost' : 'standard_cost';
const costLabel = (t: CostTrack, code: string) =>
  `${t === 'material' ? 'Material' : 'Standard'} cost — ${code}`;

type CostRow = {
  id: number;
  product_code: string;
  status: SdStatus;
  frozen: boolean;
  neg_stage: string | null;
};

async function loadCostRow(track: CostTrack, id: number) {
  const supabase = await supa();
  const table = COST_TABLE[track];
  const { data } = await supabase
    .from(table)
    .select('id, product_code, status, frozen, neg_stage')
    .eq('id', id)
    .maybeSingle();
  return { supabase, table, row: (data as CostRow | null) ?? null };
}

/** Team proposes a product/fabric for costing (optionally with an expected cost). */
export async function proposeCost(formData: FormData): Promise<ActionResult> {
  const user = await currentUser();
  if (!user) return fail('Not signed in.');
  const track = costTrackOf(formData);
  const id = Number(formData.get('id'));
  if (!id) return fail('Invalid cost row.');
  const { supabase, table, row } = await loadCostRow(track, id);
  if (!row) return fail('Cost not found.');
  if (row.frozen) return fail('This cost is frozen and cannot be renegotiated.');
  if (!canPropose(user.role, row.neg_stage)) return fail('You cannot propose this cost right now.');

  const proposed = numOrNull(formData.get('proposed_cost'));
  const { error } = await supabase
    .from(table)
    .update({
      neg_stage: 'proposed',
      proposed_cost: proposed,
      status: 'draft',
      rejection_notes: null,
      negotiation_notes: null,
      updated_at: new Date().toISOString(),
    })
    .eq('id', id);
  if (error) return fail(error.message);
  await writeLog(costEntity(track), String(id), costLabel(track, row.product_code), row.status, 'draft', user.email, `Proposed${proposed != null ? ` at ${proposed}` : ''}`);
  revalidatePath('/standard-cost');
  return done('Proposed for costing.');
}

/** Mahesh reviews a proposal and states the target cost. */
export async function setTargetCost(formData: FormData): Promise<ActionResult> {
  const user = await currentUser();
  if (!user) return fail('Not signed in.');
  const track = costTrackOf(formData);
  const id = Number(formData.get('id'));
  if (!id) return fail('Invalid cost row.');
  const { supabase, table, row } = await loadCostRow(track, id);
  if (!row) return fail('Cost not found.');
  if (!canSetTarget(user.role, row.neg_stage)) return fail('This is not awaiting a target cost.');
  const target = numOrNull(formData.get('target_cost'));
  if (target == null) return fail('Enter a target cost.');

  const { error } = await supabase
    .from(table)
    .update({ neg_stage: 'target_set', target_cost: target, updated_at: new Date().toISOString() })
    .eq('id', id);
  if (error) return fail(error.message);
  await writeLog(costEntity(track), String(id), costLabel(track, row.product_code), row.status, row.status, user.email, `Target cost ${target}`);
  revalidatePath('/standard-cost');
  return done('Target cost set.');
}

/** Team comes back from the vendor with the actual rate(s). */
export async function submitActualRate(formData: FormData): Promise<ActionResult> {
  const user = await currentUser();
  if (!user) return fail('Not signed in.');
  const track = costTrackOf(formData);
  const id = Number(formData.get('id'));
  if (!id) return fail('Invalid cost row.');
  const { supabase, table, row } = await loadCostRow(track, id);
  if (!row) return fail('Cost not found.');
  if (row.frozen) return fail('This cost is frozen and cannot be edited.');
  if (!canSubmitRate(user.role, row.neg_stage)) return fail('This is not awaiting an actual rate.');

  const patch: Record<string, unknown> = {
    neg_stage: 'rate_submitted',
    job_cost: numOrNull(formData.get('job_cost')),
    fob_cost: numOrNull(formData.get('fob_cost')),
    updated_at: new Date().toISOString(),
  };
  if (track === 'fg') patch.efob_cost = numOrNull(formData.get('efob_cost'));
  if (patch.job_cost == null && patch.fob_cost == null && patch.efob_cost == null) {
    return fail('Enter at least one actual rate.');
  }

  const { error } = await supabase.from(table).update(patch).eq('id', id);
  if (error) return fail(error.message);
  await writeLog(costEntity(track), String(id), costLabel(track, row.product_code), row.status, row.status, user.email, 'Actual rate submitted');
  revalidatePath('/standard-cost');
  return done('Actual rate submitted for sign-off.');
}

/** Mahesh signs off — the actual rate becomes the approved Standard Cost. */
export async function signOffCost(formData: FormData): Promise<ActionResult> {
  const user = await currentUser();
  if (!user) return fail('Not signed in.');
  const track = costTrackOf(formData);
  const id = Number(formData.get('id'));
  if (!id) return fail('Invalid cost row.');
  const { supabase, table, row } = await loadCostRow(track, id);
  if (!row) return fail('Cost not found.');
  if (!canSignOff(user.role, row.neg_stage)) return fail('This is not awaiting sign-off.');

  const patch: Record<string, unknown> = {
    neg_stage: 'signed_off',
    status: 'approved',
    approved_by: user.email,
    approved_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
  };
  if (track === 'fg') patch.documented = true;
  const { error } = await supabase.from(table).update(patch).eq('id', id).eq('neg_stage', 'rate_submitted');
  if (error) return fail(error.message);
  await writeLog(costEntity(track), String(id), costLabel(track, row.product_code), row.status, 'approved', user.email, 'Signed off — standard cost');
  revalidatePath('/standard-cost');
  revalidatePath('/buying-plan');
  return done('Signed off. This is now the standard cost.');
}

/** Mahesh sends the rate back for renegotiation. */
export async function renegotiateCost(formData: FormData): Promise<ActionResult> {
  const user = await currentUser();
  if (!user) return fail('Not signed in.');
  const track = costTrackOf(formData);
  const id = Number(formData.get('id'));
  const note = String(formData.get('note') ?? '').trim();
  if (!id) return fail('Invalid cost row.');
  if (!note) return fail('Give a reason to renegotiate.');
  const { supabase, table, row } = await loadCostRow(track, id);
  if (!row) return fail('Cost not found.');
  if (!canRenegotiate(user.role, row.neg_stage)) return fail('This cannot be renegotiated right now.');

  const { error } = await supabase
    .from(table)
    .update({ neg_stage: 'renegotiate', negotiation_notes: note, updated_at: new Date().toISOString() })
    .eq('id', id);
  if (error) return fail(error.message);
  await writeLog(costEntity(track), String(id), costLabel(track, row.product_code), row.status, row.status, user.email, `Renegotiate: ${note}`);
  revalidatePath('/standard-cost');
  return done('Sent back to renegotiate.');
}

/** Mahesh rejects the cost proposal/rate. */
export async function rejectCost(formData: FormData): Promise<ActionResult> {
  const user = await currentUser();
  if (!user) return fail('Not signed in.');
  const track = costTrackOf(formData);
  const id = Number(formData.get('id'));
  const note = String(formData.get('note') ?? '').trim();
  if (!id) return fail('Invalid cost row.');
  if (!note) return fail('Give a reason to reject.');
  const { supabase, table, row } = await loadCostRow(track, id);
  if (!row) return fail('Cost not found.');
  if (!canRejectCost(user.role, row.neg_stage)) return fail('This cannot be rejected right now.');

  const { error } = await supabase
    .from(table)
    .update({ neg_stage: 'rejected', status: 'rejected', rejection_notes: note, updated_at: new Date().toISOString() })
    .eq('id', id);
  if (error) return fail(error.message);
  await writeLog(costEntity(track), String(id), costLabel(track, row.product_code), row.status, 'rejected', user.email, `Rejected: ${note}`);
  revalidatePath('/standard-cost');
  return done('Cost rejected.');
}

/** The document-once standard fields (singleton) — same across all products. */
export async function saveCostStandards(formData: FormData): Promise<ActionResult> {
  const user = await currentUser();
  if (!user) return fail('Not signed in.');
  if (!canEdit(user.role, 'draft')) return fail('You do not have permission to edit cost standards.');
  const supabase = await supa();
  const { error } = await supabase.from('sd_cost_standards').upsert(
    {
      id: 1,
      fabric_cost: numOrNull(formData.get('fabric_cost')),
      dyeing_cost: numOrNull(formData.get('dyeing_cost')),
      shrinkage_pct: numOrNull(formData.get('shrinkage_pct')),
      margin_pct: numOrNull(formData.get('margin_pct')),
      payment_terms: textOrNull(formData.get('payment_terms')),
      updated_by: user.email,
      updated_at: new Date().toISOString(),
    },
    { onConflict: 'id' },
  );
  if (error) return fail(`Could not save: ${error.message}`);
  revalidatePath('/standard-cost');
  return done('Standard fields saved.');
}

/** Sequential sign-off, step 1 (FG): Mahesh confirms the fabric rate first. */
export async function confirmFabricRate(formData: FormData): Promise<ActionResult> {
  const user = await currentUser();
  if (!user) return fail('Not signed in.');
  const id = Number(formData.get('id'));
  if (!id) return fail('Invalid cost row.');
  const supabase = await supa();
  const { data: row } = await supabase
    .from('sd_standard_cost')
    .select('id, product_code, status, neg_stage, fabric_confirmed_at')
    .eq('id', id)
    .maybeSingle();
  if (!row) return fail('Cost not found.');
  if (!canConfirmFabric(user.role, row.neg_stage as string | null, !!row.fabric_confirmed_at)) {
    return fail('Fabric rate cannot be confirmed right now.');
  }
  const now = new Date().toISOString();
  const { error } = await supabase
    .from('sd_standard_cost')
    .update({ fabric_confirmed_at: now, fabric_confirmed_by: user.email, updated_at: now })
    .eq('id', id);
  if (error) return fail(error.message);
  await writeLog('standard_cost', String(id), `Standard cost — ${row.product_code}`, row.status as SdStatus, row.status as SdStatus, user.email, 'Fabric rate confirmed');
  revalidatePath('/standard-cost');
  return done('Fabric rate confirmed. Now confirm CM / other.');
}

/** Sequential sign-off, step 2 (FG): confirm CM/other → signs off = standard cost. */
export async function confirmCmRate(formData: FormData): Promise<ActionResult> {
  const user = await currentUser();
  if (!user) return fail('Not signed in.');
  const id = Number(formData.get('id'));
  if (!id) return fail('Invalid cost row.');
  const supabase = await supa();
  const { data: row } = await supabase
    .from('sd_standard_cost')
    .select('id, product_code, status, neg_stage, fabric_confirmed_at, cm_confirmed_at')
    .eq('id', id)
    .maybeSingle();
  if (!row) return fail('Cost not found.');
  if (!canConfirmCm(user.role, row.neg_stage as string | null, !!row.fabric_confirmed_at, !!row.cm_confirmed_at)) {
    return fail('Confirm the fabric rate first.');
  }
  const now = new Date().toISOString();
  const { data: updated, error } = await supabase
    .from('sd_standard_cost')
    .update({
      cm_confirmed_at: now,
      cm_confirmed_by: user.email,
      neg_stage: 'signed_off',
      status: 'approved',
      approved_by: user.email,
      approved_at: now,
      documented: true,
      updated_at: now,
    })
    .eq('id', id)
    .eq('neg_stage', 'rate_submitted')
    .select('id');
  if (error) return fail(error.message);
  if (!updated?.length) return fail('Already processed.');
  await writeLog('standard_cost', String(id), `Standard cost — ${row.product_code}`, row.status as SdStatus, 'approved', user.email, 'CM confirmed — signed off');
  revalidatePath('/standard-cost');
  revalidatePath('/buying-plan');
  return done('Signed off. This is now the standard cost.');
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
    rate: numOrNull(formData.get('rate')),
    // po_qty is NOT taken from the form — it is derived from the size lines
    // (savePoLines keeps sd_po_approval.po_qty = sum of line qty).
    po_closing_date: dateOrNull(formData.get('po_closing_date')),
    cad_folder_url: textOrNull(formData.get('cad_folder_url')),
    cs_pp_sample_due: dateOrNull(formData.get('cs_pp_sample_due')),
    cs_gpt_due: dateOrNull(formData.get('cs_gpt_due')),
    cs_cutting_start: dateOrNull(formData.get('cs_cutting_start')),
    cs_inline_qc_due: dateOrNull(formData.get('cs_inline_qc_due')),
    critical_path_first_delivery: dateOrNull(formData.get('critical_path_first_delivery')),
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
      .in('status', ['draft', 'rework']);
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
    .select('id, status, po_ref_num, category, product_code, po_qty, rate, critical_path_first_delivery')
    .eq('id', id)
    .maybeSingle();
  if (!po) return fail('PO not found.');
  if (!canSubmit(user.role, po.status as SdStatus)) {
    return fail('This PO cannot be submitted from its current state.');
  }
  const qty = Number(po.po_qty || 0);
  if (qty <= 0) return fail('Add the size lines — PO quantity is the sum of those.');
  if (po.rate == null) return fail('Fill the rate (alongside the cost sheet) before submitting.');

  const now = new Date();
  // Total days as REQUESTED at submission: requested first-delivery minus today.
  // Locked here so it doesn't drift with the eventual approval date.
  let requestedTotalDays: number | null = null;
  if (po.critical_path_first_delivery) {
    const target = new Date(`${po.critical_path_first_delivery}T00:00:00Z`).getTime();
    const start = new Date(now.toISOString().slice(0, 10) + 'T00:00:00Z').getTime();
    requestedTotalDays = Math.round((target - start) / 86_400_000);
  }

  const next = statusOnSubmit('po_approval', qty, po.category as string);
  const { data: updated, error } = await supabase
    .from('sd_po_approval')
    .update({
      status: next,
      submitted_for_approval_at: now.toISOString(),
      requested_total_days: requestedTotalDays,
      rejection_notes: null,
    })
    .eq('id', id)
    .in('status', ['draft', 'rework'])
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
    // Trim-card signing happens after the PO is raised, so it is captured here at issuance.
    trim_card_signed: formData.get('trim_card_signed') === 'true',
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

/** Fabric cost base sheet — one row per fabric_code (grey / processing / finished + yarn→grey). */
export async function saveFabricCostBase(formData: FormData): Promise<ActionResult> {
  const user = await currentUser();
  if (!user) return fail('Not signed in.');
  if (!canEdit(user.role, 'draft')) {
    return fail('You do not have permission to edit fabric costs.');
  }
  const fabric_code = String(formData.get('fabric_code') ?? '').trim().toUpperCase();
  if (!fabric_code) return fail('Fabric code is required.');

  const supabase = await supa();
  const { error } = await supabase.from('sd_fabric_cost_base').upsert(
    {
      fabric_code,
      yarn_cost: numOrNull(formData.get('yarn_cost')),
      conversion_cost: numOrNull(formData.get('conversion_cost')),
      grey_rate: numOrNull(formData.get('grey_rate')),
      processing_cost: numOrNull(formData.get('processing_cost')),
      finished_fabric_cost: numOrNull(formData.get('finished_fabric_cost')),
      notes: textOrNull(formData.get('notes')),
      updated_at: new Date().toISOString(),
    },
    { onConflict: 'fabric_code' },
  );
  if (error) return fail(`Could not save: ${error.message}`);
  revalidatePath('/fabric-cost');
  // The finished-fabric cost is auto-pulled into the Standard Cost CM matrix.
  revalidatePath('/standard-cost');
  return done(`Saved ${fabric_code}.`);
}

/* ================================================================== */
/* Material master — one code list for raw / dyed / trim + colours     */
/* ================================================================== */

const MATERIAL_TYPES = ['raw', 'dyed', 'trim'];

function readMaterialFields(formData: FormData) {
  const type = String(formData.get('material_type') ?? 'raw');
  return {
    material_type: MATERIAL_TYPES.includes(type) ? type : 'raw',
    name: textOrNull(formData.get('name')),
    colour: textOrNull(formData.get('colour')),
    base_fabric_code: textOrNull(formData.get('base_fabric_code')),
    default_uom: textOrNull(formData.get('default_uom')),
    is_active: formData.get('is_active') !== 'false',
    updated_at: new Date().toISOString(),
  };
}

/** Add a NEW material code (raw / dyed / trim). Insert-only; existing code blocked. */
export async function addMaterial(formData: FormData): Promise<ActionResult> {
  const user = await currentUser();
  if (!user) return fail('Not signed in.');
  if (!canEdit(user.role, 'draft')) {
    return fail('You do not have permission to edit the material master.');
  }
  const material_code = String(formData.get('material_code') ?? '').trim().toUpperCase();
  if (!material_code) return fail('Material code is required.');
  const fields = readMaterialFields(formData);
  if (fields.material_type === 'dyed' && (!fields.base_fabric_code || !fields.colour)) {
    return fail('A dyed fabric needs both a base fabric and a colour.');
  }

  const supabase = await supa();
  const { error } = await supabase
    .from('sd_material_master')
    .insert({ material_code, ...fields });
  if (error) {
    return fail(
      error.code === '23505'
        ? `Material code “${material_code}” already exists — use a different code.`
        : `Could not add: ${error.message}`,
    );
  }
  revalidatePath('/material-master');
  revalidatePath('/buying-plan');
  return done(`Added ${material_code}.`);
}

/** Update an existing material code's fields (code is the key, never changed). */
export async function updateMaterial(formData: FormData): Promise<ActionResult> {
  const user = await currentUser();
  if (!user) return fail('Not signed in.');
  if (!canEdit(user.role, 'draft')) {
    return fail('You do not have permission to edit the material master.');
  }
  const material_code = String(formData.get('material_code') ?? '').trim().toUpperCase();
  if (!material_code) return fail('Material code is required.');
  const fields = readMaterialFields(formData);
  if (fields.material_type === 'dyed' && (!fields.base_fabric_code || !fields.colour)) {
    return fail('A dyed fabric needs both a base fabric and a colour.');
  }

  const supabase = await supa();
  const { data: updated, error } = await supabase
    .from('sd_material_master')
    .update(fields)
    .eq('material_code', material_code)
    .select('material_code');
  if (error) return fail(`Could not save: ${error.message}`);
  if (!updated?.length) return fail('Material code not found.');
  revalidatePath('/material-master');
  revalidatePath('/buying-plan');
  return done(`Saved ${material_code}.`);
}

/** Add a colour to the managed list used to build dyed-fabric codes. */
export async function addColour(formData: FormData): Promise<ActionResult> {
  const user = await currentUser();
  if (!user) return fail('Not signed in.');
  if (!canEdit(user.role, 'draft')) {
    return fail('You do not have permission to edit colours.');
  }
  const colour = String(formData.get('colour') ?? '').trim();
  if (!colour) return fail('Colour is required.');

  const supabase = await supa();
  const { error } = await supabase.from('sd_colour_master').insert({ colour });
  if (error) {
    return fail(
      error.code === '23505'
        ? `Colour “${colour}” already exists.`
        : `Could not add: ${error.message}`,
    );
  }
  revalidatePath('/material-master');
  // Active colours populate the Buying Plan material Dyed-line colour picker.
  revalidatePath('/buying-plan');
  return done(`Added ${colour}.`);
}

/** Activate / deactivate a colour. */
export async function setColourActive(formData: FormData): Promise<ActionResult> {
  const user = await currentUser();
  if (!user) return fail('Not signed in.');
  if (!canEdit(user.role, 'draft')) {
    return fail('You do not have permission to edit colours.');
  }
  const colour = String(formData.get('colour') ?? '').trim();
  if (!colour) return fail('Invalid colour.');
  const is_active = formData.get('is_active') !== 'false';

  const supabase = await supa();
  const { error } = await supabase
    .from('sd_colour_master')
    .update({ is_active })
    .eq('colour', colour);
  if (error) return fail(`Could not save: ${error.message}`);
  revalidatePath('/material-master');
  // Toggling a colour active/inactive changes the Buying Plan colour picker options.
  revalidatePath('/buying-plan');
  return done(`${colour} ${is_active ? 'activated' : 'deactivated'}.`);
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

  if (!/^[^@\s]+@saadaa\.in$/.test(email)) return fail('Enter a valid @saadaa.in email address.');
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
