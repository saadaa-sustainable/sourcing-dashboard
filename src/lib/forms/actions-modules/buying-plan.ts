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

