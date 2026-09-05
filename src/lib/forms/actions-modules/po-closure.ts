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

export async function initiateClosure(formData: FormData): Promise<ActionResult> {
  const user = await currentUser();
  if (!user) return fail('Not signed in.');
  if (!canEdit(user.role, 'draft')) return fail('You do not have permission to initiate closure.');
  const id = Number(formData.get('id'));
  if (!id) return fail('Invalid PO closure.');

  const supabase = await supa();
  const { data: row } = await supabase
    .from('sd_po_closure')
    .select('id, easycom_completed_at, closure_initiated_at')
    .eq('id', id)
    .maybeSingle();
  if (!row) return fail('Closure not found.');
  if (!row.easycom_completed_at) return fail('This PO is not Completed in EasyCom yet — closure cannot start.');
  if (row.closure_initiated_at) return done('Already initiated.');

  const { error } = await supabase
    .from('sd_po_closure')
    .update({ closure_initiated_at: new Date().toISOString(), initiated_by: user.email })
    .eq('id', id);
  if (error) return fail(`Could not initiate: ${error.message}`);
  revalidatePath('/po-closure');
  return done('Closure initiated.');
}

/**
 * Sourcing leg: link the cutting register, compute the surplus (actual − BOM) and
 * its value (× the fabric standard cost), and submit. Finance reviews the value next.
 */
export async function submitSourcingLeg(formData: FormData): Promise<ActionResult> {
  const user = await currentUser();
  if (!user) return fail('Not signed in.');
  if (!canEdit(user.role, 'draft')) return fail('You do not have permission to submit the sourcing leg.');
  const id = Number(formData.get('id'));
  if (!id) return fail('Invalid PO closure.');
  const cuttingRef = Number(formData.get('cutting_register_ref')) || null;

  const supabase = await supa();
  const { data: cl } = await supabase
    .from('sd_po_closure')
    .select('id, easycom_completed_at, sourcing_status')
    .eq('id', id)
    .maybeSingle();
  if (!cl) return fail('Closure not found.');
  if (!cl.easycom_completed_at) return fail('This PO is not Completed yet.');

  // Surplus = actual − BOM (only when both are present), valued at the product's
  // fabric standard cost (product → sd_standard_cost.fabric_code → finished cost).
  let surplusQty: number | null = null;
  let surplusValue: number | null = null;
  if (cuttingRef) {
    const { data: cr } = await supabase
      .from('sd_cutting_register')
      .select('actual_consumption_qty, bom_standard_qty, product_code')
      .eq('id', cuttingRef)
      .maybeSingle();
    if (cr && cr.actual_consumption_qty != null && cr.bom_standard_qty != null) {
      surplusQty = Math.round((cr.actual_consumption_qty - cr.bom_standard_qty) * 100) / 100;
      if (cr.product_code) {
        const { data: sc } = await supabase
          .from('sd_standard_cost')
          .select('fabric_code')
          .eq('product_code', cr.product_code)
          .maybeSingle();
        if (sc?.fabric_code) {
          const { data: fb } = await supabase
            .from('sd_fabric_cost_base')
            .select('finished_fabric_cost')
            .eq('fabric_code', sc.fabric_code)
            .maybeSingle();
          if (fb?.finished_fabric_cost != null) {
            surplusValue = Math.round(surplusQty * Number(fb.finished_fabric_cost) * 100) / 100;
          }
        }
      }
    }
  }

  const { data: updated, error } = await supabase
    .from('sd_po_closure')
    .update({
      cutting_register_ref: cuttingRef,
      surplus_fabric_qty: surplusQty,
      surplus_fabric_value: surplusValue,
      sourcing_status: 'submitted',
      sourcing_submitted_at: new Date().toISOString(),
      sourcing_submitted_by: user.email,
    })
    .eq('id', id)
    .eq('sourcing_status', 'pending')
    .select('id');
  if (error) return fail(`Could not submit: ${error.message}`);
  if (!updated?.length) return fail('Sourcing leg was already submitted.');
  revalidatePath('/po-closure');
  return done('Sourcing leg submitted.');
}

/**
 * Finance leg: review/override the surplus value, enter challan + debit note, and
 * close. Only actionable once the sourcing leg is in. Stamps closed_at and the
 * final compliance verdict.
 */
export async function submitFinanceLeg(formData: FormData): Promise<ActionResult> {
  const user = await currentUser();
  if (!user) return fail('Not signed in.');
  if (!canEdit(user.role, 'draft')) return fail('You do not have permission to submit the finance leg.');
  const id = Number(formData.get('id'));
  if (!id) return fail('Invalid PO closure.');

  const supabase = await supa();
  const { data: cl } = await supabase
    .from('sd_po_closure')
    .select('id, easycom_completed_at, sourcing_status, sourcing_submitted_at')
    .eq('id', id)
    .maybeSingle();
  if (!cl) return fail('Closure not found.');
  if (cl.sourcing_status !== 'submitted') return fail('The sourcing leg must be submitted first.');

  const now = new Date().toISOString();
  const compliance = computeClosureCompliance({
    easycom_completed_at: cl.easycom_completed_at,
    sourcing_status: 'submitted',
    sourcing_submitted_at: cl.sourcing_submitted_at,
    finance_submitted_at: now,
    closed_at: now,
  });

  const { data: updated, error } = await supabase
    .from('sd_po_closure')
    .update({
      challan_number: textOrNull(formData.get('challan_number')),
      debit_note_number: textOrNull(formData.get('debit_note_number')),
      debit_note_value: numOrNull(formData.get('debit_note_value')),
      surplus_fabric_value: numOrNull(formData.get('surplus_fabric_value')),
      finance_remarks: textOrNull(formData.get('finance_remarks')),
      finance_status: 'submitted',
      finance_submitted_at: now,
      finance_submitted_by: user.email,
      closed_at: now,
      compliance_status: compliance.status,
    })
    .eq('id', id)
    .eq('finance_status', 'pending')
    .select('id');
  if (error) return fail(`Could not close: ${error.message}`);
  if (!updated?.length) return fail('Finance leg was already submitted.');
  revalidatePath('/po-closure');
  return done(`PO closed — ${compliance.status === 'breached' ? 'SLA breached' : 'on time'}.`);
}

/** Standard TNA lead-times (singleton) — the offsets that auto-generate the critical path. */
