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
  // Say what was excluded, by name, and flag a SKU the product master does not know —
  // a typo is far more likely than a SKU missing from the master.
  const { data: pm } = await supabase
    .from('sd_ee_product_master')
    .select('sku, product_name, colour, size')
    .eq('sku', sku)
    .maybeSingle();
  const { error } = await supabase
    .from('sd_oos_sku_exclusion')
    .upsert({ sku, reason, added_by: user.email, added_at: new Date().toISOString() });
  if (error) return fail(`Could not exclude: ${error.message}`);
  revalidatePath('/oos-calculation');
  revalidatePath('/doq-dashboard');
  const name = pm ? ` (${[pm.product_name, pm.colour, pm.size].filter(Boolean).join(' · ')})` : ' — not found in the product master, check the code';
  return done(`${sku} excluded from the DOQ calculation${name}.`);
}

export type OosSkuSuggestion = {
  sku: string;
  product_name: string | null;
  colour: string | null;
  size: string | null;
  product_state: string | null;
};

/** SKU suggestions for the exclusion box — from the product master, by SKU or product name. */
export async function searchOosSkus(query: string): Promise<OosSkuSuggestion[]> {
  const user = await currentUser();
  if (!user) return [];
  const q = String(query ?? '').trim();
  if (q.length < 2) return [];
  const supabase = await supa();
  const like = `%${q.replace(/[%_]/g, '')}%`;
  // paging-ok: a typeahead — the first 15 matches are all that is shown
  const { data } = await supabase
    .from('sd_ee_product_master')
    .select('sku, product_name, colour, size, product_state')
    .or(`sku.ilike.${like},product_name.ilike.${like}`)
    .order('sku')
    .limit(15);
  return ((data ?? []) as OosSkuSuggestion[]).map((r) => ({
    sku: String(r.sku ?? '').toUpperCase(),
    product_name: r.product_name ?? null,
    colour: r.colour ?? null,
    size: r.size ?? null,
    product_state: r.product_state ?? null,
  }));
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
  revalidatePath('/doq-dashboard');
  return done(`${sku} restored to the DOQ calculation.`);
}

/* ================================================================== */
/* Inward Plan II — team-filled monthly inward sheet (Buying Plan tab) */
/* ================================================================== */

/** Team fills / edits a row (product, PO, vendor, qty, cost, remarks, actual). */
