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

