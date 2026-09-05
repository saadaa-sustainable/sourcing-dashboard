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

