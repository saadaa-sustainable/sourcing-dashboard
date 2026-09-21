'use server';

import { revalidatePath } from 'next/cache';
import { currentUser } from '../queries';
import { canEdit, statusOnSubmit } from '../approval';
import { DEBOARDING_REASONS } from '../deboarding';
import type { VendorDeboardingReason } from '../types';
import { type ActionResult, fail, done, supa, writeLog } from './_shared';

const score = (v: unknown) => {
  const n = Number(v);
  return Number.isInteger(n) && n >= 1 && n <= 5 ? n : null;
};
const count = (v: unknown) => {
  const n = Number(String(v ?? '').trim() || 0);
  return Number.isInteger(n) && n >= 0 ? n : null;
};

/**
 * Raise a Vendor De-Boarding request. Field for field the team's Google Form; the
 * request goes to the approval queue and, like a discontinue, always needs an admin.
 */
export async function createVendorDeboardingRequest(formData: FormData): Promise<ActionResult> {
  const user = await currentUser();
  if (!user) return fail('Not signed in.');
  if (!canEdit(user.role, 'draft')) {
    return fail('You do not have permission to raise a de-boarding request.');
  }

  const vendorCode = String(formData.get('vendor_code') ?? '').trim().toUpperCase();
  const vendorName = String(formData.get('vendor_name') ?? '').trim() || null;
  const reason = String(formData.get('reason') ?? '').trim() as VendorDeboardingReason;
  const reasonOther = String(formData.get('reason_other') ?? '').trim() || null;
  const behaviour = score(formData.get('behaviour_score'));
  const workStyle = score(formData.get('work_style_score'));
  const quality = score(formData.get('quality_score'));
  const process = score(formData.get('process_score'));
  const posDone = count(formData.get('pos_done'));
  const late15 = count(formData.get('pos_late_15d'));
  const late1m = count(formData.get('pos_late_1m'));
  const lateOver1m = count(formData.get('pos_late_over_1m'));
  const rejectionRaw = String(formData.get('rejection_pct') ?? '').trim();
  const rejectionPct = rejectionRaw === '' ? null : Number(rejectionRaw);
  const resolvableRaw = String(formData.get('resolvable') ?? '');
  const remarks = String(formData.get('remarks') ?? '').trim();

  if (!vendorCode) return fail('Pick the vendor.');
  if (!DEBOARDING_REASONS.some((r) => r.key === reason)) return fail('Pick the reason for de-listing.');
  if (reason === 'other' && !reasonOther) return fail('Say what the "other" reason is.');
  if (behaviour == null || workStyle == null || quality == null || process == null) {
    return fail('Rate all four points from 1 to 5.');
  }
  if (posDone == null || late15 == null || late1m == null || lateOver1m == null) {
    return fail('PO counts must be whole numbers, 0 or more.');
  }
  if (late15 + late1m + lateOver1m > posDone) {
    return fail('The three delay counts add up to more than the POs done.');
  }
  if (rejectionPct != null && !(Number.isFinite(rejectionPct) && rejectionPct >= 0 && rejectionPct <= 100)) {
    return fail('Rejection percentage must be between 0 and 100.');
  }
  if (resolvableRaw !== 'yes' && resolvableRaw !== 'no') return fail('Say whether the issue is resolvable.');
  if (!remarks) return fail('Remarks are required.');

  const status = statusOnSubmit('vendor_deboarding');
  const supabase = await supa();
  const { data, error } = await supabase
    .from('sd_vendor_deboarding_request')
    .insert({
      vendor_code: vendorCode,
      vendor_name: vendorName,
      reason,
      reason_other: reason === 'other' ? reasonOther : null,
      behaviour_score: behaviour,
      work_style_score: workStyle,
      quality_score: quality,
      process_score: process,
      pos_done: posDone,
      pos_late_15d: late15,
      pos_late_1m: late1m,
      pos_late_over_1m: lateOver1m,
      rejection_pct: rejectionPct,
      resolvable: resolvableRaw === 'yes',
      remarks,
      status,
      requested_by: user.email,
      requested_at: new Date().toISOString(),
    })
    .select('id')
    .single();

  if (error) {
    return fail(
      error.code === '23505'
        ? `A de-boarding request for ${vendorCode} is already open.`
        : error.message,
    );
  }

  await writeLog(
    'vendor_deboarding',
    String(data.id),
    `De-board vendor — ${vendorCode}${vendorName ? ` ${vendorName}` : ''}`,
    'draft',
    status,
    user.email,
    remarks,
  );
  revalidatePath('/vendor-deboarding');
  revalidatePath('/approvals');
  return done('De-boarding request submitted for approval.');
}
