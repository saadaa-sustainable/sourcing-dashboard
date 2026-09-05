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
