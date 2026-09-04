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

import { randomBytes } from 'crypto';
import { revalidatePath } from 'next/cache';
import { createClient, hasSupabaseEnv } from '@/lib/supabase/server';
import { createAdminClient, hasSupabaseAdminEnv } from '@/lib/supabase/admin';
import { createPublicClient } from '@/lib/supabase/public';
import { computeClosureCompliance } from '@/lib/business-logic';
import { recomputeExpectedCost } from '@/lib/standard-cost';
import { currentUser, loadApprovedStandardCosts, loadApprovedMaterialCosts } from './queries';
import { canApprove, canEdit, canSubmit, statusOnSubmit } from './approval';
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
} from './cost';
import type { ApprovalEntity, PoCategory, PoType, SdRole, SdStatus } from './types';
import { INWARD_PLAN_STATUSES } from './types';

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

/**
 * Record a vendor's committed delivery date into sd_vendor_commitment_log (item
 * 1). Append-only: the first commitment for a PO is the initial event; a later,
 * different date is logged as a REVISION (keeping the original `committed_date`),
 * so revision frequency is provable. A no-op when the date is unchanged or blank.
 * Best-effort — never rolls back the PO transition that triggered it.
 */
async function recordCommitment(
  poRefNum: string | null | undefined,
  vendorCode: string | null | undefined,
  newDate: string | null | undefined,
  actorEmail: string,
) {
  if (!poRefNum || !newDate) return;
  try {
    const supabase = await supa();
    const { data: rows } = await supabase
      .from('sd_vendor_commitment_log')
      .select('committed_date, revised_date')
      .eq('po_ref_num', poRefNum)
      .order('id', { ascending: true });
    const events = (rows ?? []) as { committed_date: string; revised_date: string | null }[];
    const now = new Date().toISOString();
    if (!events.length) {
      await supabase.from('sd_vendor_commitment_log').insert({
        po_ref_num: poRefNum,
        vendor_code: vendorCode ?? null,
        committed_date: newDate,
        committed_at: now,
        logged_by: actorEmail,
      });
      return;
    }
    const latest = events[events.length - 1];
    const latestDate = latest.revised_date ?? latest.committed_date;
    if (latestDate === newDate) return; // unchanged — don't log a duplicate
    await supabase.from('sd_vendor_commitment_log').insert({
      po_ref_num: poRefNum,
      vendor_code: vendorCode ?? null,
      committed_date: events[0].committed_date, // keep the original
      revised_date: newDate,
      revised_at: now,
      logged_by: actorEmail,
    });
  } catch (error) {
    console.error('sd_vendor_commitment_log insert failed', error);
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

  // A product added to the Buying Plan is automatically added to Standard Cost —
  // seed a row for each code (on conflict do nothing, so existing costs untouched).
  const codes = [...new Set(payload.map((l) => l.product_code).filter(Boolean))];
  if (codes.length) {
    const costTable = planType === 'material' ? 'sd_material_standard_cost' : 'sd_standard_cost';
    await supabase
      .from(costTable)
      .upsert(codes.map((product_code) => ({ product_code })), {
        onConflict: 'product_code',
        ignoreDuplicates: true,
      });
  }

  revalidatePath('/buying-plan');
  revalidatePath('/standard-cost');
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
    .select('id, plan_month, status, plan_type')
    .eq('id', planId)
    .maybeSingle();
  if (!plan) return fail('Plan not found.');
  if (!canSubmit(user.role, plan.status as SdStatus)) {
    return fail('This plan cannot be submitted from its current state.');
  }

  const { data: lines } = await supabase
    .from('sd_buying_plan_line')
    .select('id, product_code, job_work_qty, fob_qty, efob_qty, standard_value, line_status')
    .eq('plan_id', planId);
  const lineRows = (lines ?? []) as {
    id: number;
    product_code: string;
    job_work_qty: number;
    fob_qty: number;
    efob_qty: number;
    standard_value: number | null;
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

  // Freeze the standard value per line at submission — from the CURRENT accepted
  // rates. After this, later rate changes never rewrite an in-flight/approved
  // plan; before submission the plan reflected the live latest-accepted rate.
  const isMaterial = (plan as { plan_type?: string }).plan_type === 'material';
  const fgCosts = isMaterial ? {} : await loadApprovedStandardCosts();
  const matCosts = isMaterial ? await loadApprovedMaterialCosts() : {};
  for (const l of lineRows) {
    const job = Number(l.job_work_qty || 0);
    const fob = Number(l.fob_qty || 0);
    const efob = Number(l.efob_qty || 0);
    if (job + fob + efob <= 0) continue;
    let value = 0;
    if (isMaterial) {
      const c = matCosts[l.product_code];
      if (!c) continue; // no accepted rate to freeze — leave as-is (still values live)
      value = job * c.job + fob * c.fob;
    } else {
      const c = fgCosts[l.product_code];
      if (!c) continue;
      value = job * c.job + fob * c.fob + efob * c.efob;
    }
    if (value > 0) {
      await supabase.from('sd_buying_plan_line').update({ standard_value: value }).eq('id', l.id);
    }
  }

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
 * Set (or update) the flat NPD monthly budget cap for a month. Admin only —
 * Sourcing leadership owns the figure; NPD sees consumption against it read-only.
 * No default is invented: an empty month simply has no cap until set here.
 */
export async function setNpdBudget(formData: FormData): Promise<ActionResult> {
  const user = await currentUser();
  if (!user) return fail('Not signed in.');
  if (user.role !== 'admin') return fail('Only an admin can set the NPD budget.');

  const month = String(formData.get('month') ?? '');
  if (!/^\d{4}-\d{2}-01$/.test(month)) return fail('Invalid month.');

  const raw = String(formData.get('cap') ?? '').replace(/[,\s₹]/g, '').trim();
  const cap = Number(raw);
  if (!Number.isFinite(cap) || cap < 0) return fail('Enter a valid cap amount (₹).');
  const note = String(formData.get('note') ?? '').trim() || null;

  const supabase = await supa();
  const { error } = await supabase.from('sd_npd_budget').upsert(
    {
      plan_month: month,
      cap_amount: cap,
      note,
      updated_by: user.email,
      updated_at: new Date().toISOString(),
    },
    { onConflict: 'plan_month' },
  );
  if (error) return fail(error.message);

  revalidatePath('/buying-plan');
  return done('NPD budget saved.');
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

/** Vendor Capacity item 1 — upsert one vendor+product capacity allocation (pieces/month). */
export async function saveVendorProductAllocation(formData: FormData): Promise<ActionResult> {
  const user = await currentUser();
  if (!user) return fail('Not signed in.');
  if (!canEdit(user.role, 'draft')) {
    return fail('You do not have permission to allocate capacity.');
  }
  const vendor_code = String(formData.get('vendor_code') ?? '').trim();
  const product_code = String(formData.get('product_code') ?? '').trim().toUpperCase();
  if (!vendor_code || !product_code) return fail('Vendor and product are required.');
  const allocated_qty = numOrNull(formData.get('allocated_qty'));
  if (allocated_qty == null || allocated_qty < 0) return fail('Enter a valid allocation (pieces/month).');

  const supabase = await supa();
  const { error } = await supabase.from('sd_vendor_product_capacity_allocation').upsert(
    { vendor_code, product_code, allocated_qty, entry_date: new Date().toISOString(), entered_by: user.email },
    { onConflict: 'vendor_code,product_code' },
  );
  if (error) return fail(`Could not save allocation: ${error.message}`);
  revalidatePath('/vendor-capacity');
  return done(`Allocated ${allocated_qty} pcs of ${product_code} to ${vendor_code}.`);
}

/** Vendor Capacity item 1 — remove a vendor+product allocation. */
export async function deleteVendorProductAllocation(formData: FormData): Promise<ActionResult> {
  const user = await currentUser();
  if (!user) return fail('Not signed in.');
  if (!canEdit(user.role, 'draft')) return fail('You do not have permission to edit allocations.');
  const id = Number(formData.get('id'));
  if (!id) return fail('Invalid allocation.');
  const supabase = await supa();
  const { error } = await supabase.from('sd_vendor_product_capacity_allocation').delete().eq('id', id);
  if (error) return fail(error.message);
  revalidatePath('/vendor-capacity');
  return done('Allocation removed.');
}

function numOrNull(value: unknown) {
  if (value === '' || value == null) return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

/**
 * Append an accepted FG rate to the history (sd_standard_cost_rate_history).
 * The latest history row per product is what the Buying Plan values from, so
 * every acceptance/sign-off records one. Best-effort: never fails the sign-off.
 */
async function recordAcceptedRate(
  supabase: Awaited<ReturnType<typeof supa>>,
  productCode: string,
  rates: { job: number | null; fob: number | null; efob: number | null },
  acceptedBy: string,
  note: string,
) {
  try {
    await supabase.from('sd_standard_cost_rate_history').insert({
      product_code: productCode,
      job_cost: rates.job,
      fob_cost: rates.fob,
      efob_cost: rates.efob,
      accepted_by: acceptedBy,
      accepted_at: new Date().toISOString(),
      note,
    });
  } catch {
    /* history is additive audit — a hiccup must not block the acceptance */
  }
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
  const { error } = await supabase.from('sd_po_closure_decision').upsert(
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

/* ================================================================== */
/* Cutting Register & dynamic links (PO Closure feature)               */
/* ================================================================== */

// product_code is encoded in po_ref_num: FY.../<TYPE>/<PRODUCT>/<VENDOR>-<SEQ>.
const productFromPoRef = (po: string) => {
  const parts = po.split('/');
  return parts[2]?.trim() || null;
};

/**
 * Authenticated Cutting Register entry. Snapshots the product's BOM standard at
 * creation time (spec §3) — reads it fresh from sd_product_master so the record
 * reflects the standard as it was at cutting, not a stale client value.
 */
export async function saveCuttingRegister(formData: FormData): Promise<ActionResult> {
  const user = await currentUser();
  if (!user) return fail('Not signed in.');
  if (!canEdit(user.role, 'draft')) return fail('You do not have permission to add cutting entries.');

  const po_ref_num = String(formData.get('po_ref_num') ?? '').trim();
  if (!po_ref_num) return fail('Enter the PO reference.');
  const actual = numOrNull(formData.get('actual_consumption_qty'));
  if (actual == null) return fail('Enter the actual consumption.');

  const product_code = productFromPoRef(po_ref_num);
  const supabase = await supa();

  // Snapshot BOM from the master (null when there's no BOM on file — never 0).
  let bomQ: number | null = null;
  let bomU: string | null = null;
  if (product_code) {
    const { data: pm } = await supabase
      .from('sd_product_master')
      .select('bom_quantity, bom_uom')
      .eq('product_code', product_code)
      .maybeSingle();
    bomQ = pm?.bom_quantity ?? null;
    bomU = pm?.bom_uom ?? null;
  }

  const { error } = await supabase.from('sd_cutting_register').insert({
    po_ref_num,
    product_code,
    bom_standard_qty: bomQ,
    bom_uom: bomU,
    actual_consumption_qty: actual,
    cutting_date: dateOrNull(formData.get('cutting_date')),
    remarks: textOrNull(formData.get('remarks')),
    submitted_via: 'dashboard',
    submitted_by_email: user.email,
  });
  if (error) return fail(`Could not save: ${error.message}`);
  revalidatePath('/cutting-register');
  return done(`Saved cutting entry for ${po_ref_num}.`);
}

export type LinkResult = { ok: true; token: string; expiresAt: string } | { ok: false; error: string };

/**
 * Generate a tokenized, expiring, single-use data-capture link for a PO's cutting
 * register. Expiry = min(created+30d, easycom_completed_at+15d) — the link doesn't
 * outlive the SLA window; 30d if the PO isn't completed yet (spec §2).
 */
export async function generateDynamicLink(formData: FormData): Promise<LinkResult> {
  const user = await currentUser();
  if (!user) return { ok: false, error: 'Not signed in.' };
  if (!canEdit(user.role, 'draft')) return { ok: false, error: 'You do not have permission to generate links.' };

  const po_ref_num = String(formData.get('po_ref_num') ?? '').trim();
  if (!po_ref_num) return { ok: false, error: 'Enter the PO reference.' };

  const token = randomBytes(24).toString('base64url');
  const supabase = await supa();

  const { data: closure } = await supabase
    .from('sd_po_closure')
    .select('easycom_completed_at')
    .eq('po_ref_num', po_ref_num)
    .maybeSingle();

  const now = Date.now();
  let expires = now + 30 * 86_400_000;
  if (closure?.easycom_completed_at) {
    expires = Math.min(expires, Date.parse(closure.easycom_completed_at) + 15 * 86_400_000);
  }
  const expiresAt = new Date(expires).toISOString();

  const { error } = await supabase.from('sd_dynamic_links').insert({
    token,
    link_type: 'cutting_register',
    po_ref_num,
    created_by: user.email,
    expires_at: expiresAt,
  });
  if (error) return { ok: false, error: `Could not generate link: ${error.message}` };
  revalidatePath('/cutting-register');
  return { ok: true, token, expiresAt };
}

/** Revoke an open link (spec §2) — needed if it was sent to the wrong person. */
export async function revokeDynamicLink(formData: FormData): Promise<ActionResult> {
  const user = await currentUser();
  if (!user) return fail('Not signed in.');
  if (!canEdit(user.role, 'draft')) return fail('You do not have permission to revoke links.');
  const id = Number(formData.get('id'));
  if (!id) return fail('Invalid link.');
  const supabase = await supa();
  const { error } = await supabase.from('sd_dynamic_links').update({ is_active: false }).eq('id', id);
  if (error) return fail(`Could not revoke: ${error.message}`);
  revalidatePath('/cutting-register');
  return done('Link revoked.');
}

/**
 * Public submission from the /fill/[token] route (no login). Runs as anon and only
 * calls the SECURITY DEFINER RPC, which re-validates the token, snapshots the BOM,
 * inserts the register row, and burns the link (single-use).
 */
export async function submitCuttingViaLink(formData: FormData): Promise<ActionResult> {
  const token = String(formData.get('token') ?? '').trim();
  const name = String(formData.get('name') ?? '').trim();
  const contact = String(formData.get('contact') ?? '').trim();
  const actual = numOrNull(formData.get('actual_consumption_qty'));
  if (!token) return fail('Invalid link.');
  if (!name || !contact) return fail('Enter your name and email/phone.');
  if (actual == null) return fail('Enter the actual consumption.');

  const supabase = createPublicClient();
  const { data, error } = await supabase.rpc('sd_submit_cutting_register', {
    p_token: token,
    p_actual: actual,
    p_cutting_date: dateOrNull(formData.get('cutting_date')),
    p_remarks: textOrNull(formData.get('remarks')),
    p_name: name,
    p_email: contact,
  });
  if (error) return fail('Could not submit — this link may no longer be active.');
  if (data === false) return fail('This link is no longer active.');
  return done('Submitted — thank you!');
}

/* ================================================================== */
/* PO Closure — gating + two-leg workflow + surplus (spec §4-5)        */
/* ================================================================== */

/** Begin closure. Gated: only a completed PO (closure row carries the stamp). */
export async function initiateClosure(formData: FormData): Promise<ActionResult> {
  const user = await currentUser();
  if (!user) return fail('Not signed in.');
  if (!canEdit(user.role, 'draft')) return fail('You do not have permission to initiate closure.');
  const id = Number(formData.get('id'));
  if (!id) return fail('Invalid PO closure.');

  const supabase = await supa();
  const { data: row } = await supabase
    .from('sd_po_closure')
    .select('id, easycom_completed_at, closure_initiated_at')
    .eq('id', id)
    .maybeSingle();
  if (!row) return fail('Closure not found.');
  if (!row.easycom_completed_at) return fail('This PO is not Completed in EasyCom yet — closure cannot start.');
  if (row.closure_initiated_at) return done('Already initiated.');

  const { error } = await supabase
    .from('sd_po_closure')
    .update({ closure_initiated_at: new Date().toISOString(), initiated_by: user.email })
    .eq('id', id);
  if (error) return fail(`Could not initiate: ${error.message}`);
  revalidatePath('/po-closure');
  return done('Closure initiated.');
}

/**
 * Sourcing leg: link the cutting register, compute the surplus (actual − BOM) and
 * its value (× the fabric standard cost), and submit. Finance reviews the value next.
 */
export async function submitSourcingLeg(formData: FormData): Promise<ActionResult> {
  const user = await currentUser();
  if (!user) return fail('Not signed in.');
  if (!canEdit(user.role, 'draft')) return fail('You do not have permission to submit the sourcing leg.');
  const id = Number(formData.get('id'));
  if (!id) return fail('Invalid PO closure.');
  const cuttingRef = Number(formData.get('cutting_register_ref')) || null;

  const supabase = await supa();
  const { data: cl } = await supabase
    .from('sd_po_closure')
    .select('id, easycom_completed_at, sourcing_status')
    .eq('id', id)
    .maybeSingle();
  if (!cl) return fail('Closure not found.');
  if (!cl.easycom_completed_at) return fail('This PO is not Completed yet.');

  // Surplus = actual − BOM (only when both are present), valued at the product's
  // fabric standard cost (product → sd_standard_cost.fabric_code → finished cost).
  let surplusQty: number | null = null;
  let surplusValue: number | null = null;
  if (cuttingRef) {
    const { data: cr } = await supabase
      .from('sd_cutting_register')
      .select('actual_consumption_qty, bom_standard_qty, product_code')
      .eq('id', cuttingRef)
      .maybeSingle();
    if (cr && cr.actual_consumption_qty != null && cr.bom_standard_qty != null) {
      surplusQty = Math.round((cr.actual_consumption_qty - cr.bom_standard_qty) * 100) / 100;
      if (cr.product_code) {
        const { data: sc } = await supabase
          .from('sd_standard_cost')
          .select('fabric_code')
          .eq('product_code', cr.product_code)
          .maybeSingle();
        if (sc?.fabric_code) {
          const { data: fb } = await supabase
            .from('sd_fabric_cost_base')
            .select('finished_fabric_cost')
            .eq('fabric_code', sc.fabric_code)
            .maybeSingle();
          if (fb?.finished_fabric_cost != null) {
            surplusValue = Math.round(surplusQty * Number(fb.finished_fabric_cost) * 100) / 100;
          }
        }
      }
    }
  }

  const { data: updated, error } = await supabase
    .from('sd_po_closure')
    .update({
      cutting_register_ref: cuttingRef,
      surplus_fabric_qty: surplusQty,
      surplus_fabric_value: surplusValue,
      sourcing_status: 'submitted',
      sourcing_submitted_at: new Date().toISOString(),
      sourcing_submitted_by: user.email,
    })
    .eq('id', id)
    .eq('sourcing_status', 'pending')
    .select('id');
  if (error) return fail(`Could not submit: ${error.message}`);
  if (!updated?.length) return fail('Sourcing leg was already submitted.');
  revalidatePath('/po-closure');
  return done('Sourcing leg submitted.');
}

/**
 * Finance leg: review/override the surplus value, enter challan + debit note, and
 * close. Only actionable once the sourcing leg is in. Stamps closed_at and the
 * final compliance verdict.
 */
export async function submitFinanceLeg(formData: FormData): Promise<ActionResult> {
  const user = await currentUser();
  if (!user) return fail('Not signed in.');
  if (!canEdit(user.role, 'draft')) return fail('You do not have permission to submit the finance leg.');
  const id = Number(formData.get('id'));
  if (!id) return fail('Invalid PO closure.');

  const supabase = await supa();
  const { data: cl } = await supabase
    .from('sd_po_closure')
    .select('id, easycom_completed_at, sourcing_status, sourcing_submitted_at')
    .eq('id', id)
    .maybeSingle();
  if (!cl) return fail('Closure not found.');
  if (cl.sourcing_status !== 'submitted') return fail('The sourcing leg must be submitted first.');

  const now = new Date().toISOString();
  const compliance = computeClosureCompliance({
    easycom_completed_at: cl.easycom_completed_at,
    sourcing_status: 'submitted',
    sourcing_submitted_at: cl.sourcing_submitted_at,
    finance_submitted_at: now,
    closed_at: now,
  });

  const { data: updated, error } = await supabase
    .from('sd_po_closure')
    .update({
      challan_number: textOrNull(formData.get('challan_number')),
      debit_note_number: textOrNull(formData.get('debit_note_number')),
      debit_note_value: numOrNull(formData.get('debit_note_value')),
      surplus_fabric_value: numOrNull(formData.get('surplus_fabric_value')),
      finance_remarks: textOrNull(formData.get('finance_remarks')),
      finance_status: 'submitted',
      finance_submitted_at: now,
      finance_submitted_by: user.email,
      closed_at: now,
      compliance_status: compliance.status,
    })
    .eq('id', id)
    .eq('finance_status', 'pending')
    .select('id');
  if (error) return fail(`Could not close: ${error.message}`);
  if (!updated?.length) return fail('Finance leg was already submitted.');
  revalidatePath('/po-closure');
  return done(`PO closed — ${compliance.status === 'breached' ? 'SLA breached' : 'on time'}.`);
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

  const patch: Record<string, unknown> = {
    product_code,
    job_cost: numOrNull(formData.get('job_cost')),
    fob_cost: numOrNull(formData.get('fob_cost')),
    efob_cost: numOrNull(formData.get('efob_cost')),
    total_po_avg_cost: numOrNull(formData.get('total_po_avg_cost')),
    cad_link: textOrNull(formData.get('cad_link')),
    rfp_link: textOrNull(formData.get('rfp_link')),
    fabric_code: textOrNull(formData.get('fabric_code')),
    // Saving is the act of documenting — clears the "data gap" flag.
    documented: true,
    updated_at: new Date().toISOString(),
  };
  // cm_cost is owned by the CMTP breakdown (saveCmtpComponents). Only touch it
  // when a caller explicitly sends it, so a header save never wipes the CMTP total.
  if (formData.has('cm_cost')) patch.cm_cost = numOrNull(formData.get('cm_cost'));
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
 * Soft-delete / restore a Standard Cost product. Hiding removes it from the worklist
 * but keeps EVERYTHING — the cost row, lines, CMTP, rate history — untouched; only the
 * `hidden` flag flips. Restoring (re-adding via search) un-hides it, fully intact. This
 * is why re-adding routes here, NOT through saveStandardCost (which would overwrite).
 */
export async function setStandardCostHidden(formData: FormData): Promise<ActionResult> {
  const user = await currentUser();
  if (!user) return fail('Not signed in.');
  if (!canEdit(user.role, 'draft')) {
    return fail('You do not have permission to change the Standard Cost list.');
  }
  const product_code = String(formData.get('product_code') ?? '').trim();
  if (!product_code) return fail('Product code is required.');
  const hidden = formData.get('hidden') === 'true';
  const table = formData.get('track') === 'material' ? 'sd_material_standard_cost' : 'sd_standard_cost';

  const supabase = await supa();
  const { error } = await supabase
    .from(table)
    .update({ hidden, updated_at: new Date().toISOString() })
    .eq('product_code', product_code);
  if (error) return fail(`Could not ${hidden ? 'remove' : 'restore'}: ${error.message}`);

  revalidatePath('/standard-cost');
  return done(
    hidden
      ? `${product_code} removed from the list (its data is kept — add it again to restore).`
      : `${product_code} restored — all fields and history intact.`,
  );
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

  let lines: {
    colour?: string;
    size?: string;
    consumption?: unknown;
    fabric_cost?: unknown;
    cm_cost?: unknown;
    total_cost?: unknown;
  }[] = [];
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
      consumption: numOrNull(l.consumption),
      fabric_cost: numOrNull(l.fabric_cost),
      cm_cost: numOrNull(l.cm_cost),
      total_cost: numOrNull(l.total_cost),
    }))
    .filter(
      (l) =>
        l.colour ||
        l.size ||
        l.consumption != null ||
        l.fabric_cost != null ||
        l.cm_cost != null ||
        l.total_cost != null,
    );

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

/**
 * Replace the CMTP (Cutting/Manufacturing/Trims/Packaging) breakdown for one
 * product. The sum of all line-item amounts becomes the product's CM cost
 * (sd_standard_cost.cm_cost) — the CMTP breakdown is the authoritative CM source.
 */
export async function saveCmtpComponents(formData: FormData): Promise<ActionResult> {
  const user = await currentUser();
  if (!user) return fail('Not signed in.');
  if (!canEdit(user.role, 'draft')) {
    return fail('You do not have permission to edit standard costs.');
  }
  const product_code = String(formData.get('product_code') ?? '').trim();
  if (!product_code) return fail('Product code is required.');

  let rows: { category?: string; label?: string; amount?: unknown }[] = [];
  try {
    rows = JSON.parse(String(formData.get('components') ?? '[]'));
  } catch {
    rows = [];
  }

  const supabase = await supa();
  const { data: parent } = await supabase
    .from('sd_standard_cost')
    .select('id, frozen, cm_cost')
    .eq('product_code', product_code)
    .maybeSingle();
  if (parent?.frozen) return fail('This cost is frozen and can no longer be edited.');

  // Keep only rows that carry a head; drop fully-empty scratch rows.
  const clean = rows
    .map((r, i) => ({
      product_code,
      category: String(r.category ?? '').trim(),
      label: textOrNull(r.label),
      amount: numOrNull(r.amount),
      position: i,
    }))
    .filter((r) => r.category && (r.label != null || r.amount != null));

  const total = clean.reduce((s, r) => s + (r.amount ?? 0), 0);

  // Item 2 — line-item revision with mandatory reason. Diff the incoming lines
  // against what's on file (keyed by head + sub-item). If this is a REVISION of an
  // existing breakdown (rows already existed) and any line's amount moved / a line
  // was added or removed, the reviser must say why — that reason is logged per
  // changed line to sd_cmtp_revision (old → new, who, when), the audit trail shown
  // in Rate History. First-time entry needs no reason.
  const { data: existing } = await supabase
    .from('sd_cmtp_component')
    .select('category, label, amount')
    .eq('product_code', product_code);
  const lineKey = (cat: string, label: string | null) => cat + ' :: ' + (label ?? '');
  const oldByKey = new Map<string, number | null>(
    (existing ?? []).map((r) => [lineKey(String(r.category), textOrNull(r.label)), numOrNull(r.amount)]),
  );
  const amtEq = (a: number | null, b: number | null) =>
    (a == null && b == null) || (a != null && b != null && Math.abs(a - b) < 0.005);
  type LineChange = { category: string; label: string | null; old: number | null; next: number | null };
  const changes: LineChange[] = [];
  const seen = new Set<string>();
  for (const r of clean) {
    const k = lineKey(r.category, r.label);
    seen.add(k);
    const old = oldByKey.has(k) ? oldByKey.get(k) ?? null : null;
    if (!oldByKey.has(k) || !amtEq(old, r.amount)) {
      changes.push({ category: r.category, label: r.label, old, next: r.amount });
    }
  }
  for (const r of existing ?? []) {
    const k = lineKey(String(r.category), textOrNull(r.label));
    if (!seen.has(k)) {
      changes.push({ category: String(r.category), label: textOrNull(r.label), old: numOrNull(r.amount), next: null });
    }
  }
  const isRevision = (existing?.length ?? 0) > 0 && changes.length > 0;
  const reason = String(formData.get('revision_reason') ?? '').trim();
  if (isRevision && !reason) {
    return fail(
      'This changes an existing CMTP breakdown — enter a reason for the revision (e.g. "karigar rate increased"). It is logged in the rate history.',
    );
  }

  // Replace strategy: clear the product's CMTP rows, then insert the current set.
  await supabase.from('sd_cmtp_component').delete().eq('product_code', product_code);
  if (clean.length) {
    const { error } = await supabase.from('sd_cmtp_component').insert(clean);
    if (error) return fail(`Could not save CMTP breakdown: ${error.message}`);
  }

  // Append the line-level revision audit (best-effort — never blocks the save).
  if (isRevision) {
    const cmBefore = parent?.cm_cost == null ? null : Number(parent.cm_cost);
    const cmAfter = clean.length ? total : null;
    await supabase.from('sd_cmtp_revision').insert(
      changes.map((c) => ({
        product_code,
        category: c.category,
        label: c.label,
        old_amount: c.old,
        new_amount: c.next,
        cm_before: cmBefore,
        cm_after: cmAfter,
        reason,
        revised_by: user.email,
      })),
    );
  }

  // CMTP total is the CM cost. Saving is documenting — clears the data-gap flag.
  const { error: upErr } = await supabase.from('sd_standard_cost').upsert(
    {
      product_code,
      cm_cost: clean.length ? total : null,
      documented: true,
      updated_at: new Date().toISOString(),
    },
    { onConflict: 'product_code' },
  );
  if (upErr) return fail(`Could not save CM cost: ${upErr.message}`);

  revalidatePath('/standard-cost');
  return done(`Saved CMTP breakdown for ${product_code} — CM ${total}.`);
}

/**
 * Add a new standardized sub-item to the CMTP master under a head. Managed +
 * addable (team/admin) rather than a hardcoded enum, so a genuinely new sub-item
 * can be introduced without a code change — recorded with who added it. A name
 * that already exists in the head is a no-op (keeps the list de-duplicated).
 */
export async function addCmtpSubitem(formData: FormData): Promise<ActionResult> {
  const user = await currentUser();
  if (!user) return fail('Not signed in.');
  if (!canEdit(user.role, 'draft')) {
    return fail('You do not have permission to add CMTP sub-items.');
  }
  const category = String(formData.get('category') ?? '').trim();
  const name = String(formData.get('name') ?? '').trim();
  if (!category || !name) return fail('Both a head and a sub-item name are required.');

  const supabase = await supa();
  const { error } = await supabase
    .from('sd_cmtp_subitem')
    .upsert(
      { category, name, created_by: user.email },
      { onConflict: 'category,name', ignoreDuplicates: true },
    );
  if (error) return fail(`Could not add sub-item: ${error.message}`);

  revalidatePath('/standard-cost');
  return done(`Added “${name}” under ${category}.`);
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
  job_cost: number | null;
  fob_cost: number | null;
  efob_cost?: number | null; // FG only — the material table has no E-FOB column
};

async function loadCostRow(track: CostTrack, id: number) {
  const supabase = await supa();
  const table = COST_TABLE[track];
  const { data } = await supabase
    .from(table)
    .select(
      `id, product_code, status, frozen, neg_stage, job_cost, fob_cost${track === 'fg' ? ', efob_cost' : ''}`,
    )
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

  // The team may propose the rate under any PO type (Job / FOB / E-FOB), so the
  // admin can see which rate belongs to which type — plus an optional overall
  // "expected" figure. At least one value is required.
  const proposed = numOrNull(formData.get('proposed_cost'));
  const job = numOrNull(formData.get('job_cost'));
  const fob = numOrNull(formData.get('fob_cost'));
  const efob = track === 'fg' ? numOrNull(formData.get('efob_cost')) : null;
  if (proposed == null && job == null && fob == null && efob == null) {
    return fail('Enter at least one proposed rate (Job / FOB / E-FOB) or an expected cost.');
  }

  const patch: Record<string, unknown> = {
    neg_stage: 'proposed',
    proposed_cost: proposed,
    job_cost: job,
    fob_cost: fob,
    status: 'draft',
    rejection_notes: null,
    negotiation_notes: null,
    updated_at: new Date().toISOString(),
  };
  if (track === 'fg') patch.efob_cost = efob;

  const { error } = await supabase.from(table).update(patch).eq('id', id);
  if (error) return fail(error.message);
  const rateSummary = [
    job != null ? `Job ${job}` : null,
    fob != null ? `${track === 'material' ? 'Purchase' : 'FOB'} ${fob}` : null,
    efob != null ? `E-FOB ${efob}` : null,
  ]
    .filter(Boolean)
    .join(', ');
  const detail = [rateSummary, proposed != null ? `expected ${proposed}` : null]
    .filter(Boolean)
    .join(' · ');
  await writeLog(costEntity(track), String(id), costLabel(track, row.product_code), row.status, 'draft', user.email, `Proposed${detail ? ` (${detail})` : ''}`);
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

/** Admin accepts the proposal as-is — the proposed rates become the Standard Cost. */
export async function acceptProposedCost(formData: FormData): Promise<ActionResult> {
  const user = await currentUser();
  if (!user) return fail('Not signed in.');
  const track = costTrackOf(formData);
  const id = Number(formData.get('id'));
  if (!id) return fail('Invalid cost row.');
  const { supabase, table, row } = await loadCostRow(track, id);
  if (!row) return fail('Cost not found.');
  if (!canAcceptProposal(user.role, row.neg_stage)) return fail('This is not an open proposal.');
  if (row.job_cost == null && row.fob_cost == null && row.efob_cost == null) {
    return fail('The proposal names no rate — set a target instead of accepting.');
  }

  const patch: Record<string, unknown> = {
    neg_stage: 'signed_off',
    status: 'approved',
    approved_by: user.email,
    approved_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
  };
  if (track === 'fg') patch.documented = true;
  // Guarded on the stage so a concurrent reject/target can't be overwritten.
  const { error } = await supabase.from(table).update(patch).eq('id', id).eq('neg_stage', 'proposed');
  if (error) return fail(error.message);
  if (track === 'fg') {
    await recordAcceptedRate(
      supabase, row.product_code,
      { job: row.job_cost, fob: row.fob_cost, efob: row.efob_cost ?? null },
      user.email, 'Proposal accepted as-is',
    );
  }
  await writeLog(costEntity(track), String(id), costLabel(track, row.product_code), row.status, 'approved', user.email, 'Proposal accepted as-is — standard cost');
  revalidatePath('/standard-cost');
  revalidatePath('/buying-plan');
  return done('Proposal accepted. This is now the standard cost.');
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

/**
 * Set the EFOB fabric-cost benchmark for a month (spec §6) — a fixed rate the
 * company sets monthly for carrying commodity risk on EFOB POs.
 */
export async function saveEfobFabricCost(formData: FormData): Promise<ActionResult> {
  const user = await currentUser();
  if (!user) return fail('Not signed in.');
  if (!canEdit(user.role, 'draft')) return fail('You do not have permission to set the EFOB fabric cost.');
  const fabric_code = String(formData.get('fabric_code') ?? '').trim();
  if (!fabric_code) return fail('Pick a fabric — the EFOB rate is set per fabric.');
  const raw = String(formData.get('month') ?? '').trim();
  if (!raw) return fail('Pick a month.');
  const month = `${raw.slice(0, 7)}-01`; // normalise 'YYYY-MM' or 'YYYY-MM-DD' → first of month
  const rate = numOrNull(formData.get('rate'));
  if (rate == null) return fail('Enter the EFOB fabric rate.');

  const supabase = await supa();
  const { error } = await supabase.from('sd_efob_fabric_cost').upsert(
    { fabric_code, month, rate, updated_by: user.email, updated_at: new Date().toISOString() },
    { onConflict: 'fabric_code,month' },
  );
  if (error) return fail(`Could not save: ${error.message}`);
  revalidatePath('/standard-cost');
  return done(`EFOB rate set for ${fabric_code} · ${month.slice(0, 7)}.`);
}

/** Admin: set a Rules Master value (sd_analytics_rule) — e.g. PO-type lead times (§7). */
export async function saveAnalyticsRule(formData: FormData): Promise<ActionResult> {
  const user = await currentUser();
  if (!user) return fail('Not signed in.');
  if (user.role !== 'admin') return fail('Only an admin can edit the Rules Master.');
  const rule_key = String(formData.get('rule_key') ?? '').trim();
  const value = numOrNull(formData.get('value'));
  if (!rule_key) return fail('Missing rule.');
  if (value == null) return fail('Enter a value.');

  const supabase = await supa();
  const { error } = await supabase
    .from('sd_analytics_rule')
    .update({ value, updated_by: user.email, updated_at: new Date().toISOString() })
    .eq('rule_key', rule_key);
  if (error) return fail(`Could not save: ${error.message}`);
  revalidatePath('/buying-plan');
  revalidatePath('/rules-master');
  revalidatePath('/');
  return done('Rule updated.');
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
    .select('id, product_code, status, neg_stage, fabric_confirmed_at, cm_confirmed_at, job_cost, fob_cost, efob_cost')
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
  await recordAcceptedRate(
    supabase, row.product_code as string,
    { job: row.job_cost as number | null, fob: row.fob_cost as number | null, efob: row.efob_cost as number | null },
    user.email, 'Signed off — CM confirmed',
  );
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
    // Per-PO cost pivot (spec §5) — commodity params + the gated CM figure.
    grey_cost: numOrNull(formData.get('grey_cost')),
    finished_fabric_cost: numOrNull(formData.get('finished_fabric_cost')),
    cm_cost: numOrNull(formData.get('cm_cost')),
    margin_pct: numOrNull(formData.get('margin_pct')),
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

/**
 * Item 1 — sequencing gate. Returns a failing ActionResult if the reverse-sequencing
 * rule is ON and no APPROVED Standard Cost exists for the product; returns null to
 * pass. Read straight from sd_analytics_rule (default 0/off) so it never touches the
 * held queries.ts rule map. Material POs check sd_material_standard_cost; FG/NPD
 * check sd_standard_cost. A frozen cost was necessarily approved, so it also passes.
 */
async function assertApprovedStandardCost(
  supabase: Awaited<ReturnType<typeof supa>>,
  category: string,
  productCode: string | null,
): Promise<ActionResult | null> {
  const { data: rule } = await supabase
    .from('sd_analytics_rule')
    .select('value')
    .eq('rule_key', 'enforce_standard_cost_before_po')
    .maybeSingle();
  const enforce = Number(rule?.value ?? 0) >= 1;
  if (!enforce) return null;

  const code = (productCode ?? '').trim();
  if (!code) {
    return fail('Set the product before submitting — an approved Standard Cost is required first.');
  }
  const isMaterial = category === 'mat';
  const table = isMaterial ? 'sd_material_standard_cost' : 'sd_standard_cost';
  const { data: sc } = await supabase
    .from(table)
    .select('status, frozen')
    .eq('product_code', code)
    .maybeSingle();
  const approved = sc?.status === 'approved' || sc?.frozen === true;
  if (!approved) {
    const where = isMaterial ? 'Material Standard Cost' : 'Standard Cost';
    return fail(
      `No approved ${where} exists for ${code}. Propose and get the cost approved (freeze it) first — the PO issues against that approved cost, not a number typed here.`,
    );
  }
  return null;
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

  // Item 1 — reverse sequencing gate: the Standard Cost must be proposed, reviewed
  // and APPROVED before a PO can be submitted against it (not typed ad hoc here and
  // backfilled afterward). Rules-Master toggle `enforce_standard_cost_before_po`
  // (default 0/off — see migration; PO Approval is live and costs aren't populated
  // yet, so this stays staged until the team turns it on). When on, block unless an
  // approved cost record exists: FG/NPD → sd_standard_cost, Material → sd_material_standard_cost.
  const gateResult = await assertApprovedStandardCost(
    supabase,
    po.category as string,
    po.product_code as string | null,
  );
  if (gateResult) return gateResult;

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
    .select('id, status, product_code, po_type, po_ref_num, vendor_code, po_issued_at, critical_path_first_delivery, cm_cost, cm_override_at')
    .eq('id', id)
    .maybeSingle();
  if (!po) return fail('PO not found.');
  if (po.status !== 'approved') return fail('Only an approved PO can be issued.');

  const alreadyIssued = Boolean(po.po_issued_at);
  // The EasyCom number is required to first issue; once issued it can be edited.
  if (!alreadyIssued && !easycom) return fail('Enter the EasyCom PO number to issue.');

  // §7 issuance gate vs the approval log: a PO can't be ISSUED at an above-standard
  // CMTP unless that exception was separately approved (logged). Confirming here with
  // a mandatory remark records it (cm_override_* + sd_approval_log); a PO already
  // carrying a logged exception passes. Validates against the log, not a static number.
  let costException: { poCm: number; stdCm: number } | null = null;
  if (!alreadyIssued && po.cm_cost != null && po.product_code && !po.cm_override_at) {
    const { data: std } = await supabase
      .from('sd_standard_cost')
      .select('cm_cost')
      .eq('product_code', po.product_code)
      .maybeSingle();
    const stdCm = std?.cm_cost == null ? null : Number(std.cm_cost);
    if (stdCm != null && Number(po.cm_cost) > stdCm + 0.005) {
      const override = formData.get('cost_override') === 'true';
      const note = String(formData.get('cost_override_note') ?? '').trim();
      if (!override || !note) {
        return fail(
          `This PO's CMTP ₹${po.cm_cost} is above the standard ₹${stdCm} and was never separately approved. Confirm the above-standard cost with a reason to issue.`,
        );
      }
      costException = { poCm: Number(po.cm_cost), stdCm };
    }
  }

  // §4 live recompute (audit trail): stamp the expected FINAL price computed at
  // the CURRENT fabric rate — the basis a vendor submission is validated against,
  // not the frozen standard. Best-effort: silently skipped if cost inputs are
  // missing (today they mostly are), and never blocks issuance.
  const recomputePatch: Record<string, unknown> = {};
  if (!alreadyIssued && po.product_code) {
    try {
      const [{ data: sc }, { data: lines }] = await Promise.all([
        supabase.from('sd_standard_cost').select('fabric_code, cm_cost').eq('product_code', po.product_code).maybeSingle(),
        supabase.from('sd_standard_cost_line').select('consumption, fabric_cost').eq('product_code', po.product_code),
      ]);
      const cons = (lines ?? []).map((l) => Number(l.consumption)).filter((n) => n > 0);
      const avgCons = cons.length ? cons.reduce((s, n) => s + n, 0) / cons.length : 0;
      const baked = (lines ?? [])
        .map((l) => (Number(l.consumption) > 0 ? Number(l.fabric_cost) / Number(l.consumption) : 0))
        .filter((n) => n > 0);
      const rateAtStd = baked.length ? baked.reduce((s, n) => s + n, 0) / baked.length : null;
      // Resolve the product's fabric: the Standard Cost sheet's fabric first, else the
      // Product Master relation (product → rm_fabric_sku), so it works without manual entry.
      let fabricCode: string | null = sc?.fabric_code ?? null;
      if (!fabricCode) {
        const { data: pf } = await supabase
          .from('sd_product_fabric')
          .select('fabric_code')
          .eq('product_code', po.product_code)
          .maybeSingle();
        fabricCode = (pf?.fabric_code as string | null) ?? null;
      }
      let rateNow: number | null = null;
      if (fabricCode) {
        // An EFOB PO is validated against the EFOB monthly rate the company set for
        // this fabric (carrying the commodity risk), for the current month — falling
        // back to the fabric's finished rate when no EFOB rate is set yet.
        if (String(po.po_type ?? '').toLowerCase().includes('efob')) {
          const now = new Date();
          const month = `${now.getUTCFullYear()}-${String(now.getUTCMonth() + 1).padStart(2, '0')}-01`;
          const { data: ef } = await supabase
            .from('sd_efob_fabric_cost')
            .select('rate')
            .eq('fabric_code', fabricCode)
            .eq('month', month)
            .maybeSingle();
          rateNow = ef?.rate == null ? null : Number(ef.rate);
        }
        if (rateNow == null) {
          const { data: fb } = await supabase
            .from('sd_fabric_cost_base')
            .select('finished_fabric_cost')
            .eq('fabric_code', fabricCode)
            .maybeSingle();
          rateNow = fb?.finished_fabric_cost == null ? null : Number(fb.finished_fabric_cost);
        }
      }
      if (rateNow != null && avgCons > 0 && sc?.cm_cost != null) {
        const rc = recomputeExpectedCost({ consumption: avgCons, fabricRateNow: rateNow, cmtp: Number(sc.cm_cost), fabricRateAtStd: rateAtStd });
        recomputePatch.expected_cost_recomputed = rc.expected.final;
        recomputePatch.expected_fabric_rate_now = rc.fabricRateNow;
        recomputePatch.expected_recomputed_at = new Date().toISOString();
      }
    } catch {
      /* audit-only — never block issuance on a missing-input recompute */
    }
  }

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
  if (costException) {
    patch.cm_override_note = String(formData.get('cost_override_note') ?? '').trim();
    patch.cm_override_by = user.email;
    patch.cm_override_at = new Date().toISOString();
  }
  Object.assign(patch, recomputePatch);

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
    // Item 1: log the vendor's initial committed delivery date at issuance.
    await recordCommitment(
      po.po_ref_num as string | null,
      po.vendor_code as string | null,
      po.critical_path_first_delivery as string | null,
      user.email,
    );
  }

  // Log the above-standard-cost exception so issuance validates against the log.
  if (costException) {
    await writeLog(
      'po_approval',
      String(id),
      `PO ${easycom || `#${id}`} · above-standard cost approved at issuance`,
      'approved',
      'approved',
      user.email,
      `CMTP ₹${costException.poCm} > standard ₹${costException.stdCm}. Reason: ${String(formData.get('cost_override_note') ?? '').trim()}`,
    );
  }

  // Timeline-change flag (soft, spec: PO cycle-time / closure logic). After
  // approval the planned timeline is locked; if the ACTUAL first delivery lands
  // past the APPROVED first-delivery date, that's the "extended after approval"
  // case (the 13-day-extension incident). We never block — we surface + log it so
  // it can't slip by unnoticed.
  const actual = patch.first_actual_delivery_date as string | null;
  const approved = po.critical_path_first_delivery as string | null;
  let extNote: string | null = null;
  if (actual && approved) {
    const days = Math.round((Date.parse(actual) - Date.parse(approved)) / 86_400_000);
    if (days > 0) {
      extNote = `Delivery extended ${days} day(s) beyond approved timeline (approved ${approved} → actual ${actual}).`;
      await writeLog(
        'po_approval',
        String(id),
        `PO ${easycom || `#${id}`} · timeline extended ${days}d`,
        'approved',
        'approved',
        user.email,
        extNote,
      );
    }
  }

  revalidatePath('/po-approval');
  revalidatePath('/standard-cost');
  revalidatePath('/approvals');
  const base = alreadyIssued ? 'Signing details saved.' : `Issued as EasyCom PO ${easycom}.`;
  return done(extNote ? `${base} ⚠ ${extNote}` : base);
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
    .select('id, status, po_ref_num, vendor_code')
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
  // Item 1: log the committed first-delivery date (a change vs the last logged
  // date is recorded as a revision, keeping the original).
  await recordCommitment(
    po.po_ref_num as string | null,
    po.vendor_code as string | null,
    dateOrNull(formData.get('critical_path_first_delivery')),
    user.email,
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

/**
 * Item 2 — set the authoritative category / sub-category override for a product code
 * on sd_product_master. Both are mandatory (this IS the "mandatory at product level"
 * enforcement point). Upserts only these two columns, so an existing row's status /
 * fabric_type are preserved. Everything reads the coalesced sd_product_catalog view,
 * so this one field flows to the Buying Plan snapshot, Group By, Cost Analytics, etc.
 */
export async function saveProductCategory(formData: FormData): Promise<ActionResult> {
  const user = await currentUser();
  if (!user) return fail('Not signed in.');
  if (!canEdit(user.role, 'draft')) {
    return fail('You do not have permission to edit the product master.');
  }
  const product_code = String(formData.get('product_code') ?? '').trim();
  if (!product_code) return fail('Product code is required.');
  const category = String(formData.get('category') ?? '').trim();
  const sub_category = String(formData.get('sub_category') ?? '').trim();
  if (!category || !sub_category) {
    return fail('Both category and sub-category are required — they are mandatory at product level.');
  }

  const supabase = await supa();
  const { error } = await supabase.from('sd_product_master').upsert(
    { product_code, category, sub_category, updated_at: new Date().toISOString() },
    { onConflict: 'product_code' },
  );
  if (error) return fail(`Could not save: ${error.message}`);

  revalidatePath('/category-mapping');
  revalidatePath('/buying-plan');
  revalidatePath('/cost-analytics');
  return done(`Saved category for ${product_code}.`);
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

/**
 * Item 5 — the mandatory monthly fabric-rate submission. Each fabric must be
 * reviewed every month: either an updated grey/finished rate, or an explicit
 * "no change". Both are valid submissions; a missing month is what the pending
 * reminder surfaces. A real change writes through to sd_fabric_cost_base (the live
 * rate feeding the recompute); "no change" just records the month was reviewed,
 * carrying the current rates forward for the audit.
 */
export async function submitFabricRate(formData: FormData): Promise<ActionResult> {
  const user = await currentUser();
  if (!user) return fail('Not signed in.');
  if (!canEdit(user.role, 'draft')) {
    return fail('You do not have permission to submit fabric rates.');
  }
  const fabric_code = String(formData.get('fabric_code') ?? '').trim().toUpperCase();
  if (!fabric_code) return fail('Fabric code is required.');
  const noChange = formData.get('no_change') === 'true';

  // The month this submission covers: first of the current month (UTC).
  const now = new Date();
  const month = `${now.getUTCFullYear()}-${String(now.getUTCMonth() + 1).padStart(2, '0')}-01`;

  const supabase = await supa();
  const { data: base } = await supabase
    .from('sd_fabric_cost_base')
    .select('grey_rate, finished_fabric_cost')
    .eq('fabric_code', fabric_code)
    .maybeSingle();

  let greyRate: number | null;
  let finishedRate: number | null;
  if (noChange) {
    // Carry the live rates forward — nothing to write through.
    greyRate = base?.grey_rate == null ? null : Number(base.grey_rate);
    finishedRate = base?.finished_fabric_cost == null ? null : Number(base.finished_fabric_cost);
  } else {
    greyRate = numOrNull(formData.get('grey_rate'));
    finishedRate = numOrNull(formData.get('finished_rate'));
    if (greyRate == null && finishedRate == null) {
      return fail('Enter the new grey and/or finished rate, or choose “No change”.');
    }
    // Write the changed rate through to the live fabric cost base.
    const patch: Record<string, unknown> = { updated_at: new Date().toISOString() };
    if (greyRate != null) patch.grey_rate = greyRate;
    if (finishedRate != null) patch.finished_fabric_cost = finishedRate;
    const { error: upErr } = await supabase
      .from('sd_fabric_cost_base')
      .upsert({ fabric_code, ...patch }, { onConflict: 'fabric_code' });
    if (upErr) return fail(`Could not update the live rate: ${upErr.message}`);
  }

  const { error } = await supabase.from('sd_fabric_rate_submission').upsert(
    {
      fabric_code,
      month,
      grey_rate: greyRate,
      finished_rate: finishedRate,
      no_change: noChange,
      submitted_by: user.email,
      submitted_at: new Date().toISOString(),
    },
    { onConflict: 'fabric_code,month' },
  );
  if (error) return fail(`Could not record the submission: ${error.message}`);

  revalidatePath('/fabric-cost');
  revalidatePath('/standard-cost');
  return done(
    noChange
      ? `${fabric_code}: no change recorded for this month.`
      : `${fabric_code}: rate updated and submitted for this month.`,
  );
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

/* ------------------------------------------------------------------ */
/* Custom roles (User Panel — named view sets, multi-role per user)    */
/* ------------------------------------------------------------------ */

/** Create or update a custom role (name, description, view set). Admin-only. */
export async function saveCustomRole(formData: FormData): Promise<ActionResult> {
  const actor = await currentUser();
  if (!actor) return fail('Not signed in.');
  if (actor.role !== 'admin') return fail('Only an admin can manage roles.');

  const id = Number(formData.get('id')) || null;
  const name = String(formData.get('name') ?? '').trim();
  const description = String(formData.get('description') ?? '').trim() || null;
  let pages: string[];
  try {
    pages = JSON.parse(String(formData.get('pages') ?? '[]'));
  } catch {
    return fail('Invalid view list.');
  }
  if (!name) return fail('Give the role a name.');
  if (!Array.isArray(pages)) return fail('Invalid view list.');

  const supabase = await supa();
  const { error } = id
    ? await supabase.from('sd_custom_role').update({ name, description, pages }).eq('id', id)
    : await supabase.from('sd_custom_role').insert({ name, description, pages });
  if (error) {
    return fail(
      error.message.includes('duplicate')
        ? `A role named "${name}" already exists.`
        : `Could not save role: ${error.message}`,
    );
  }
  revalidatePath('/users');
  return done(id ? `Updated role "${name}".` : `Created role "${name}".`);
}

/** Delete a custom role; its assignments cascade away. Admin-only. */
export async function deleteCustomRole(formData: FormData): Promise<ActionResult> {
  const actor = await currentUser();
  if (!actor) return fail('Not signed in.');
  if (actor.role !== 'admin') return fail('Only an admin can manage roles.');
  const id = Number(formData.get('id'));
  if (!id) return fail('Invalid role.');
  const supabase = await supa();
  const { error } = await supabase.from('sd_custom_role').delete().eq('id', id);
  if (error) return fail(`Could not delete role: ${error.message}`);
  revalidatePath('/users');
  return done('Role deleted.');
}

/** Replace a user's custom-role set (a person can hold several). Admin-only. */
export async function setUserRoles(formData: FormData): Promise<ActionResult> {
  const actor = await currentUser();
  if (!actor) return fail('Not signed in.');
  if (actor.role !== 'admin') return fail('Only an admin can manage roles.');

  const email = String(formData.get('email') ?? '').trim().toLowerCase();
  let roleIds: number[];
  try {
    roleIds = JSON.parse(String(formData.get('role_ids') ?? '[]'));
  } catch {
    return fail('Invalid role list.');
  }
  if (!email || !Array.isArray(roleIds)) return fail('Invalid request.');

  const supabase = await supa();
  // Full replace: delete then re-insert the set (small N, admin-gated).
  const { error: delErr } = await supabase.from('sd_user_role').delete().eq('user_email', email);
  if (delErr) return fail(`Could not update roles: ${delErr.message}`);
  if (roleIds.length) {
    const { error: insErr } = await supabase
      .from('sd_user_role')
      .insert(roleIds.map((role_id) => ({ user_email: email, role_id })));
    if (insErr) return fail(`Could not update roles: ${insErr.message}`);
  }
  revalidatePath('/users');
  return done(`Updated roles for ${email}.`);
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

/* ------------------------------------------------------------------ */
/* OOS Calculation — team-managed SKU exclusion list                   */
/* ------------------------------------------------------------------ */

/** Team/admin: exclude a SKU from the OOS Calculation view. */
export async function addOosExclusion(formData: FormData): Promise<ActionResult> {
  const user = await currentUser();
  if (!user) return fail('Not signed in.');
  if (user.role === 'viewer') return fail('Only team or admin can manage OOS exclusions.');
  const sku = String(formData.get('sku') ?? '').trim().toUpperCase();
  const reason = String(formData.get('reason') ?? '').trim() || null;
  if (!sku) return fail('Enter a SKU.');

  const supabase = await supa();
  const { error } = await supabase
    .from('sd_oos_sku_exclusion')
    .upsert({ sku, reason, added_by: user.email, added_at: new Date().toISOString() });
  if (error) return fail(`Could not exclude: ${error.message}`);
  revalidatePath('/oos-calculation');
  return done(`${sku} excluded from the OOS calculation.`);
}

/** Team/admin: bring a SKU back into the OOS Calculation view. */
export async function removeOosExclusion(formData: FormData): Promise<ActionResult> {
  const user = await currentUser();
  if (!user) return fail('Not signed in.');
  if (user.role === 'viewer') return fail('Only team or admin can manage OOS exclusions.');
  const sku = String(formData.get('sku') ?? '').trim();
  if (!sku) return fail('Missing SKU.');

  const supabase = await supa();
  const { error } = await supabase.from('sd_oos_sku_exclusion').delete().eq('sku', sku);
  if (error) return fail(`Could not remove: ${error.message}`);
  revalidatePath('/oos-calculation');
  return done(`${sku} restored to the OOS calculation.`);
}

/* ================================================================== */
/* Inward Plan II — team-filled monthly inward sheet (Buying Plan tab) */
/* ================================================================== */

/** Team fills / edits a row (product, PO, vendor, qty, cost, remarks, actual). */
export async function saveInwardPlanEntry(formData: FormData): Promise<ActionResult> {
  const user = await currentUser();
  if (!user) return fail('Not signed in.');
  if (user.role === 'viewer') return fail('Only team or admin can edit the inward plan.');

  const id = Number(formData.get('id')) || null;
  const plan_month = String(formData.get('plan_month') ?? '');
  if (!/^\d{4}-\d{2}-01$/.test(plan_month)) return fail('Invalid plan month.');
  const product_code = String(formData.get('product_code') ?? '').trim().toUpperCase();
  if (!product_code) return fail('Pick a product code.');
  const text = (k: string) => {
    const v = String(formData.get(k) ?? '').trim();
    return v || null;
  };

  const patch = {
    plan_month,
    product_code,
    po_no: text('po_no'),
    vendor_name: text('vendor_name'),
    inward_qty: numOrNull(formData.get('inward_qty')),
    cost_per_piece: numOrNull(formData.get('cost_per_piece')),
    remarks: text('remarks'),
    actual_inward_qty: numOrNull(formData.get('actual_inward_qty')),
    updated_by: user.email,
    updated_at: new Date().toISOString(),
  };
  const supabase = await supa();
  if (id) {
    const { error } = await supabase.from('sd_inward_plan_entry').update(patch).eq('id', id);
    if (error) return fail(error.message);
  } else {
    const { error } = await supabase
      .from('sd_inward_plan_entry')
      .insert({ ...patch, created_by: user.email });
    if (error) return fail(error.message);
  }
  revalidatePath('/buying-plan');
  return done(id ? 'Row saved.' : `${product_code} added to the inward plan.`);
}

/** Admin review: MT comments + approval status (Pending / Approved / RE-WORK / Rejected). */
export async function reviewInwardPlanEntry(formData: FormData): Promise<ActionResult> {
  const user = await currentUser();
  if (!user) return fail('Not signed in.');
  if (user.role !== 'admin') return fail('Only an admin can review inward plan rows.');

  const id = Number(formData.get('id'));
  if (!id) return fail('Invalid row.');
  const status = String(formData.get('approval_status') ?? '').trim();
  if (!INWARD_PLAN_STATUSES.includes(status)) {
    return fail('Invalid approval status.');
  }
  const mt = String(formData.get('mt_comments') ?? '').trim() || null;

  const supabase = await supa();
  const { data: row } = await supabase
    .from('sd_inward_plan_entry')
    .select('product_code, po_no, approval_status')
    .eq('id', id)
    .maybeSingle();
  if (!row) return fail('Row not found.');

  const { error } = await supabase
    .from('sd_inward_plan_entry')
    .update({ mt_comments: mt, approval_status: status, updated_by: user.email, updated_at: new Date().toISOString() })
    .eq('id', id);
  if (error) return fail(error.message);

  if (status !== (row as { approval_status: string }).approval_status) {
    // Audit trail only — the sheet's status vocabulary mapped onto the shared log's.
    const logStatus: SdStatus =
      status === 'Approved' ? 'approved' : status === 'Rejected' ? 'rejected' : status === 'RE-WORK' ? 'rework' : 'submitted';
    const r = row as { product_code: string; po_no: string | null };
    await writeLog('inward_plan', String(id), `Inward plan — ${r.product_code}${r.po_no ? ` (${r.po_no})` : ''}`, null, logStatus, user.email, mt ?? undefined);
  }
  revalidatePath('/buying-plan');
  return done('Review saved.');
}

/** Team/admin: remove a row (e.g. duplicate or wrong PO). */
export async function deleteInwardPlanEntry(formData: FormData): Promise<ActionResult> {
  const user = await currentUser();
  if (!user) return fail('Not signed in.');
  if (user.role === 'viewer') return fail('Only team or admin can edit the inward plan.');
  const id = Number(formData.get('id'));
  if (!id) return fail('Invalid row.');
  const supabase = await supa();
  const { error } = await supabase.from('sd_inward_plan_entry').delete().eq('id', id);
  if (error) return fail(error.message);
  revalidatePath('/buying-plan');
  return done('Row removed.');
}
