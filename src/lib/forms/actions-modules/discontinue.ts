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

