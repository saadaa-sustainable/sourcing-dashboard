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

