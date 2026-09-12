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

export async function submitReceivablePlan(remarks?: string): Promise<ActionResult> {
  const user = await currentUser();
  if (!user) return fail('Not signed in.');
  if (!canSubmit(user.role, 'draft')) return fail('You do not have permission to submit.');
  const note = String(remarks ?? '').trim() || null;
  const now = new Date().toISOString();
  const supabase = await supa();
  const { data, error } = await supabase
    .from('sd_receivable_input')
    .update({ status: 'submitted', submitted_by: user.email, submitted_at: now, submit_notes: note })
    .eq('status', 'draft')
    .select('row_key');
  if (error) return fail(error.message);
  const count = data?.length ?? 0;
  // Record the submission (and the team's remark) in the approval history so the
  // approver sees it immediately, before deciding.
  if (count) {
    await writeLog('receivable_plan', 'batch', `Receivable plan — ${count} row(s)`, 'draft', 'submitted', user.email, note || undefined);
  }
  revalidatePath('/receivable-plan');
  revalidatePath('/approvals');
  return done(`Submitted ${count} row(s) for approval.`);
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

  const granularity = String(formData.get('receiving_granularity') ?? 'week') === 'month' ? 'month' : 'week';
  const deliveryDate = dateOrNull(formData.get('delivery_date_this_week'));
  const qty = numOrNull(formData.get('qty_expected_this_week'));

  const supabase = await supa();

  // Approval rule: once a row's MONTH is approved, the team may switch to any week
  // inside that month with no re-approval. Anything else — a new month, a week
  // outside the approved month, or a quantity change — drops it back to draft so
  // it must be submitted and approved again.
  const { data: existing } = await supabase
    .from('sd_receivable_input')
    .select('status, approved_month, qty_expected_this_week')
    .eq('row_key', row_key)
    .maybeSingle();

  const approvedMonth = (existing?.approved_month as string | null) ?? null;
  const monthOf = (iso: string | null) => (iso ? `${iso.slice(0, 7)}-01` : null);
  const qtyUnchanged = qty === ((existing?.qty_expected_this_week as number | null) ?? null);
  const weekWithinApprovedMonth =
    granularity === 'week' && !!approvedMonth && !!deliveryDate && monthOf(deliveryDate) === approvedMonth;

  // Stay approved only when the sole change is a week inside the already-approved
  // month (quantity untouched); otherwise the edit needs approval afresh.
  const keepApproved =
    existing?.status === 'approved' && weekWithinApprovedMonth && qtyUnchanged;
  const status: SdStatus = keepApproved ? 'approved' : 'draft';

  const { error } = await supabase.from('sd_receivable_input').upsert(
    {
      row_key,
      po_number: po_number ?? null,
      product_variant: product_variant ?? null,
      delivery_date_this_week: deliveryDate,
      receiving_granularity: granularity,
      qty_expected_this_week: qty,
      status,
      updated_by: user.email,
      updated_at: new Date().toISOString(),
    },
    { onConflict: 'row_key' },
  );
  if (error) return fail(`Could not save: ${error.message}`);
  revalidatePath('/receivable-plan');
  revalidatePath('/approvals');
  return done(
    keepApproved
      ? 'Saved — week updated within the approved month, no re-approval needed.'
      : 'Saved as draft — submit for approval.',
  );
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

