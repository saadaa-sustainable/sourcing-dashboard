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

