'use server';

import { randomBytes } from 'crypto';
import { revalidatePath } from 'next/cache';
import { createClient, hasSupabaseEnv } from '@/lib/supabase/server';
import { createAdminClient, hasSupabaseAdminEnv } from '@/lib/supabase/admin';
import { createPublicClient } from '@/lib/supabase/public';
import { computeClosureCompliance, tnaBaseFor, tnaDaysFromDates } from '@/lib/business-logic';
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

export async function saveTnaLeadtimes(formData: FormData): Promise<ActionResult> {
  const user = await currentUser();
  if (!user) return fail('Not signed in.');
  if (!canEdit(user.role, 'draft')) return fail('You do not have permission to edit TNA lead-times.');
  const intOrNull = (v: FormDataEntryValue | null) => {
    const n = Number(v);
    return v == null || String(v).trim() === '' || !Number.isFinite(n) ? null : Math.round(n);
  };
  const supabase = await supa();
  const { error } = await supabase.from('sd_tna_leadtimes').upsert(
    {
      id: 1,
      pp_sample_days: intOrNull(formData.get('pp_sample_days')),
      gpt_days: intOrNull(formData.get('gpt_days')),
      cutting_days: intOrNull(formData.get('cutting_days')),
      inline_qc_days: intOrNull(formData.get('inline_qc_days')),
      first_delivery_days: intOrNull(formData.get('first_delivery_days')),
      po_closing_days: intOrNull(formData.get('po_closing_days')),
      updated_by: user.email,
      updated_at: new Date().toISOString(),
    },
    { onConflict: 'id' },
  );
  if (error) return fail(`Could not save: ${error.message}`);
  revalidatePath('/po-approval');
  return done('TNA lead-times saved.');
}

/* ================================================================== */
/* Standard cost sheet                                                 */
/* ================================================================== */

export async function confirmTna(formData: FormData): Promise<ActionResult> {
  const user = await currentUser();
  if (!user) return fail('Not signed in.');

  const id = Number(formData.get('id'));
  if (!id) return fail('Invalid PO.');

  const supabase = await supa();
  const { data: po } = await supabase
    .from('sd_po_approval')
    .select('id, status, po_ref_num, vendor_code, po_issued_at')
    .eq('id', id)
    .maybeSingle();
  if (!po) return fail('PO not found.');

  const status = po.status as SdStatus;
  if (!canApprove(user.role, status)) {
    return fail('Only this PO’s approver can confirm its TNA dates.');
  }

  // Spec 7.3 — the approver still adjusts DATES here, because that is how a critical path
  // reads. Each edit is converted back into days against the PO's own base, so the day
  // counts stay the stored plan: if EasyCom issuance then slips, the approver's adjustment
  // slips with it instead of being a date nobody can hit any more.
  const base = tnaBaseFor({ po_issued_at: po.po_issued_at as string | null }).date;
  const dates = {
    ppSample: dateOrNull(formData.get('cs_pp_sample_due')),
    gpt: dateOrNull(formData.get('cs_gpt_due')),
    cutting: dateOrNull(formData.get('cs_cutting_start')),
    inlineQc: dateOrNull(formData.get('cs_inline_qc_due')),
    firstDelivery: dateOrNull(formData.get('critical_path_first_delivery')),
    poClosing: dateOrNull(formData.get('po_closing_date')),
  };
  const days = tnaDaysFromDates(base, dates);

  const now = new Date().toISOString();
  const { data: updated, error } = await supabase
    .from('sd_po_approval')
    .update({
      po_closing_date: dates.poClosing,
      cs_pp_sample_due: dates.ppSample,
      cs_gpt_due: dates.gpt,
      cs_cutting_start: dates.cutting,
      cs_inline_qc_due: dates.inlineQc,
      critical_path_first_delivery: dates.firstDelivery,
      tna_base_date: base,
      tna_days_pp_sample: days.ppSample,
      tna_days_gpt: days.gpt,
      tna_days_cutting: days.cutting,
      tna_days_inline_qc: days.inlineQc,
      tna_days_first_delivery: days.firstDelivery,
      tna_days_po_closing: days.poClosing,
      tna_confirmed: true,
      tna_confirmed_by: user.email,
      tna_confirmed_at: now,
    })
    .eq('id', id)
    .eq('status', status)
    .select('id');
  if (error) return fail(error.message);
  if (!updated?.length) return fail('This PO changed state — reload and try again.');

  await writeLog(
    'po_approval',
    String(id),
    `PO ${po.po_ref_num ?? `#${id}`} · TNA confirmed`,
    status,
    status,
    user.email,
    'TNA dates confirmed',
  );
  // Item 1: log the committed first-delivery date (a change vs the last logged
  // date is recorded as a revision, keeping the original).
  await recordCommitment(
    po.po_ref_num as string | null,
    po.vendor_code as string | null,
    dates.firstDelivery,
    user.email,
  );
  revalidatePath('/po-approval');
  return done('TNA dates confirmed — cost approval is now unblocked.');
}

/* ================================================================== */
/* Product master — status + woven/knitted, read by the Buying Plan    */
/* ================================================================== */

