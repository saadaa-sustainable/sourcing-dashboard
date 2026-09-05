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

export async function saveInwardPlanEntry(formData: FormData): Promise<ActionResult> {
  const user = await currentUser();
  if (!user) return fail('Not signed in.');
  if (user.role === 'viewer') return fail('Only team or admin can edit the inward plan.');

  const id = Number(formData.get('id')) || null;
  const plan_month = String(formData.get('plan_month') ?? '');
  if (!/^\d{4}-\d{2}-01$/.test(plan_month)) return fail('Invalid plan month.');
  const product_code = String(formData.get('product_code') ?? '').trim().toUpperCase();
  if (!product_code) return fail('Pick a product code.');
  const text = (k: string) => {
    const v = String(formData.get(k) ?? '').trim();
    return v || null;
  };

  const patch = {
    plan_month,
    product_code,
    po_no: text('po_no'),
    vendor_name: text('vendor_name'),
    inward_qty: numOrNull(formData.get('inward_qty')),
    cost_per_piece: numOrNull(formData.get('cost_per_piece')),
    remarks: text('remarks'),
    actual_inward_qty: numOrNull(formData.get('actual_inward_qty')),
    updated_by: user.email,
    updated_at: new Date().toISOString(),
  };
  const supabase = await supa();
  if (id) {
    const { error } = await supabase.from('sd_inward_plan_entry').update(patch).eq('id', id);
    if (error) return fail(error.message);
  } else {
    const { error } = await supabase
      .from('sd_inward_plan_entry')
      .insert({ ...patch, created_by: user.email });
    if (error) return fail(error.message);
  }
  revalidatePath('/buying-plan');
  return done(id ? 'Row saved.' : `${product_code} added to the inward plan.`);
}

/** Admin review: MT comments + approval status (Pending / Approved / RE-WORK / Rejected). */
export async function reviewInwardPlanEntry(formData: FormData): Promise<ActionResult> {
  const user = await currentUser();
  if (!user) return fail('Not signed in.');
  if (user.role !== 'admin') return fail('Only an admin can review inward plan rows.');

  const id = Number(formData.get('id'));
  if (!id) return fail('Invalid row.');
  const status = String(formData.get('approval_status') ?? '').trim();
  if (!INWARD_PLAN_STATUSES.includes(status)) {
    return fail('Invalid approval status.');
  }
  const mt = String(formData.get('mt_comments') ?? '').trim() || null;

  const supabase = await supa();
  const { data: row } = await supabase
    .from('sd_inward_plan_entry')
    .select('product_code, po_no, approval_status')
    .eq('id', id)
    .maybeSingle();
  if (!row) return fail('Row not found.');

  const { error } = await supabase
    .from('sd_inward_plan_entry')
    .update({ mt_comments: mt, approval_status: status, updated_by: user.email, updated_at: new Date().toISOString() })
    .eq('id', id);
  if (error) return fail(error.message);

  if (status !== (row as { approval_status: string }).approval_status) {
    // Audit trail only — the sheet's status vocabulary mapped onto the shared log's.
    const logStatus: SdStatus =
      status === 'Approved' ? 'approved' : status === 'Rejected' ? 'rejected' : status === 'RE-WORK' ? 'rework' : 'submitted';
    const r = row as { product_code: string; po_no: string | null };
    await writeLog('inward_plan', String(id), `Inward plan — ${r.product_code}${r.po_no ? ` (${r.po_no})` : ''}`, null, logStatus, user.email, mt ?? undefined);
  }
  revalidatePath('/buying-plan');
  return done('Review saved.');
}

/** Team/admin: remove a row (e.g. duplicate or wrong PO). */
export async function deleteInwardPlanEntry(formData: FormData): Promise<ActionResult> {
  const user = await currentUser();
  if (!user) return fail('Not signed in.');
  if (user.role === 'viewer') return fail('Only team or admin can edit the inward plan.');
  const id = Number(formData.get('id'));
  if (!id) return fail('Invalid row.');
  const supabase = await supa();
  const { error } = await supabase.from('sd_inward_plan_entry').delete().eq('id', id);
  if (error) return fail(error.message);
  revalidatePath('/buying-plan');
  return done('Row removed.');
}
