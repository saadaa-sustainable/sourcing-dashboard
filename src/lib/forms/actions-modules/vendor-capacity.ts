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

export async function saveVendorCapacityRow(formData: FormData): Promise<ActionResult> {
  const user = await currentUser();
  if (!user) return fail('Not signed in.');
  if (!canEdit(user.role, 'draft')) {
    return fail('You do not have permission to update vendor capacity.');
  }

  const vendor_code = String(formData.get('vendor_code') ?? '').trim();
  if (!vendor_code) return fail('Vendor code is required.');

  // One current row per vendor: this save overwrites just this vendor's record and
  // re-stamps entry_date, without touching or requiring any other vendor.
  const now = new Date().toISOString();
  const row = {
    vendor_code,
    vendor_name: formData.get('vendor_name') ? String(formData.get('vendor_name')) : null,
    machines_allocated: numOrNull(formData.get('machines_allocated')),
    active_karigar: numOrNull(formData.get('active_karigar')),
    capacity_per_month: numOrNull(formData.get('capacity_per_month')),
    submitted_by: user.email,
    submitted_at: now,
    entry_date: now,
  };

  const supabase = await supa();
  const { error } = await supabase
    .from('sd_vendor_capacity_log')
    .upsert(row, { onConflict: 'vendor_code' });
  if (error) return fail(`Could not save capacity: ${error.message}`);

  revalidatePath('/vendor-capacity');
  // Capacity/month feeds the PO Approval vendor headroom tab (main page + queue).
  revalidatePath('/po-approval');
  revalidatePath('/approvals');
  return done(`Saved capacity for ${vendor_code}.`);
}

/** Vendor Capacity item 1 — upsert one vendor+product capacity allocation (pieces/month). */
export async function saveVendorProductAllocation(formData: FormData): Promise<ActionResult> {
  const user = await currentUser();
  if (!user) return fail('Not signed in.');
  if (!canEdit(user.role, 'draft')) {
    return fail('You do not have permission to allocate capacity.');
  }
  const vendor_code = String(formData.get('vendor_code') ?? '').trim();
  const product_code = String(formData.get('product_code') ?? '').trim().toUpperCase();
  if (!vendor_code || !product_code) return fail('Vendor and product are required.');
  const allocated_qty = numOrNull(formData.get('allocated_qty'));
  if (allocated_qty == null || allocated_qty < 0) return fail('Enter a valid allocation (pieces/month).');

  const supabase = await supa();
  const { error } = await supabase.from('sd_vendor_product_capacity_allocation').upsert(
    { vendor_code, product_code, allocated_qty, entry_date: new Date().toISOString(), entered_by: user.email },
    { onConflict: 'vendor_code,product_code' },
  );
  if (error) return fail(`Could not save allocation: ${error.message}`);
  revalidatePath('/vendor-capacity');
  return done(`Allocated ${allocated_qty} pcs of ${product_code} to ${vendor_code}.`);
}

/** Vendor Capacity item 1 — remove a vendor+product allocation. */
export async function deleteVendorProductAllocation(formData: FormData): Promise<ActionResult> {
  const user = await currentUser();
  if (!user) return fail('Not signed in.');
  if (!canEdit(user.role, 'draft')) return fail('You do not have permission to edit allocations.');
  const id = Number(formData.get('id'));
  if (!id) return fail('Invalid allocation.');
  const supabase = await supa();
  const { error } = await supabase.from('sd_vendor_product_capacity_allocation').delete().eq('id', id);
  if (error) return fail(error.message);
  revalidatePath('/vendor-capacity');
  return done('Allocation removed.');
}

