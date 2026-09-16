'use server';

import { isPlanFrozen } from '../approval';
import { submitPlanCore } from '@/lib/plan-submit';

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
  // Month-end freeze (spec item 5): once the month has ended the plan takes no direct
  // edits. The only way in is an amendment routed through approval — the plan must
  // already be in 'rework' (requestPlanAmendment, or an approver sending it back).
  if (isPlanFrozen(planMonth) && status !== 'rework') {
    return fail(
      `The ${planMonth.slice(0, 7)} plan is closed — it froze at month-end. To change it, request an amendment; it goes through approval.`,
    );
  }
  if (!canEdit(user.role, status)) {
    return fail(
      status === 'approved'
        ? 'This plan is approved and can no longer be edited directly — request an amendment (it goes through approval).'
        : 'You do not have permission to edit the buying plan.',
    );
  }
  // A plan sitting in the approval queue is what the approver is reading — saving
  // over it would replace every line (new ids) under them and void line approvals.
  // Edits go through Rework, which hands the plan back to the team.
  if (status === 'submitted' || status === 'pending_l2') {
    return fail('This plan is awaiting approval. Ask the approver to send it back for rework to edit it.');
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
    .select('product_code, job_work_qty, fob_qty, efob_qty, colour, uom, material_type, line_status, rework_notes')
    .eq('plan_id', planId);
  const priorByCode = new Map<
    string,
    {
      job: number; fob: number; efob: number;
      colour: string | null; uom: string | null; material_type: string | null;
      line_status: SdStatus | null; rework_notes: string | null;
    }
  >();
  for (const p of (prior ?? []) as Record<string, unknown>[]) {
    priorByCode.set(String(p.product_code), {
      job: Number(p.job_work_qty || 0),
      fob: Number(p.fob_qty || 0),
      efob: Number(p.efob_qty || 0),
      colour: (p.colour ?? null) as string | null,
      uom: (p.uom ?? null) as string | null,
      material_type: (p.material_type ?? null) as string | null,
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
      const colour = line.colour ? String(line.colour) : null;
      const uom = line.uom ? String(line.uom) : null;
      const materialType = line.material_type ? String(line.material_type) : null;
      // A line keeps its approval only if nothing the approver looked at changed —
      // quantities, and on the material track also colour / UOM / material type.
      const unchanged =
        before && before.job === job && before.fob === fob && before.efob === efob &&
        before.colour === colour && before.uom === uom && before.material_type === materialType;
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
        uom,
        line_status: unchanged ? before!.line_status : null,
        rework_notes: unchanged ? before!.rework_notes : null,
        // Material track only (FG leaves these null): Job-Work rate, free remark,
        // and which material type (raw/dyed/trim) the line belongs to.
        job_rate:
          line.job_rate === '' || line.job_rate == null ? null : Number(line.job_rate),
        remark: line.remark ? String(line.remark) : null,
        material_type: materialType,
        colour,
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
  return { ok: true, message: `Saved ${payload.length} product lines.`, id: planId };
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

  // The submit itself (quantity check, routing, per-line value freeze, line approval
  // set, audit log) is the shared core — the same routine the month-end auto-submit
  // runs — so a manual and an automatic submission are indistinguishable downstream.
  const res = await submitPlanCore(supabase, planId, { email: user.email });
  if (!res.ok) return fail(res.error);
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

  // Approve the selected lines, scoped to this plan as a safety measure. The
  // returned ids tell us whether the lines still exist (a re-save replaces them).
  const { data: touched, error: lineErr } = await supabase
    .from('sd_buying_plan_line')
    .update({ line_status: 'approved', rework_notes: null })
    .eq('plan_id', planId)
    .in('id', lineIds)
    .select('id');
  if (lineErr) return fail(lineErr.message);
  if (!touched?.length) {
    return fail('Those lines no longer exist — the plan was re-saved. Reload and review the current lines.');
  }

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

