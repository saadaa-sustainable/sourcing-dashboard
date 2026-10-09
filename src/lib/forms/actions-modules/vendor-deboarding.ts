'use server';

import { revalidatePath } from 'next/cache';
import { currentUser } from '../queries';
import { canEdit, statusOnSubmit } from '../approval';
import { DEBOARDING_REASONS } from '../deboarding';
import type { SdStatus, VendorDeboardingReason } from '../types';
import { type ActionResult, fail, done, supa, writeLog } from './_shared';

const score = (v: unknown) => {
  const n = Number(v);
  return Number.isInteger(n) && n >= 1 && n <= 5 ? n : null;
};
const count = (v: unknown) => {
  const n = Number(String(v ?? '').trim() || 0);
  return Number.isInteger(n) && n >= 0 ? n : null;
};

type DeboardingFields = {
  vendor_code: string;
  vendor_name: string | null;
  reason: VendorDeboardingReason;
  reason_other: string | null;
  behaviour_score: number;
  work_style_score: number;
  quality_score: number;
  process_score: number;
  pos_done: number;
  pos_late_15d: number;
  pos_late_1m: number;
  pos_late_over_1m: number;
  rejection_pct: number | null;
  resolvable: boolean;
  remarks: string;
};

/** The user-entered fields of a de-boarding request, read and checked from a form. */
function deboardingFields(formData: FormData): { ok: true; v: DeboardingFields } | { ok: false; error: string } {
  const bad = (error: string) => ({ ok: false as const, error });
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

  if (!vendorCode) return bad('Pick the vendor.');
  if (!DEBOARDING_REASONS.some((r) => r.key === reason)) return bad('Pick the reason for de-listing.');
  if (reason === 'other' && !reasonOther) return bad('Say what the "other" reason is.');
  if (behaviour == null || workStyle == null || quality == null || process == null) {
    return bad('Rate all four points from 1 to 5.');
  }
  if (posDone == null || late15 == null || late1m == null || lateOver1m == null) {
    return bad('PO counts must be whole numbers, 0 or more.');
  }
  if (late15 + late1m + lateOver1m > posDone) {
    return bad('The three delay counts add up to more than the POs done.');
  }
  if (rejectionPct != null && !(Number.isFinite(rejectionPct) && rejectionPct >= 0 && rejectionPct <= 100)) {
    return bad('Rejection percentage must be between 0 and 100.');
  }
  if (resolvableRaw !== 'yes' && resolvableRaw !== 'no') return bad('Say whether the issue is resolvable.');
  if (!remarks) return bad('Remarks are required.');

  return {
    ok: true,
    v: {
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
    },
  };
}

const deboardLabel = (v: { vendor_code: string; vendor_name: string | null }) =>
  `De-board vendor — ${v.vendor_code}${v.vendor_name ? ` ${v.vendor_name}` : ''}`;

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

  const f = deboardingFields(formData);
  if (!f.ok) return fail(f.error);

  const status = statusOnSubmit('vendor_deboarding');
  const supabase = await supa();
  const { data, error } = await supabase
    .from('sd_vendor_deboarding_request')
    .insert({
      ...f.v,
      status,
      requested_by: user.email,
      requested_at: new Date().toISOString(),
    })
    .select('id')
    .single();

  if (error) {
    return fail(
      error.code === '23505'
        ? `A de-boarding request for ${f.v.vendor_code} is already open.`
        : error.message,
    );
  }

  await writeLog('vendor_deboarding', String(data.id), deboardLabel(f.v), 'draft', status, user.email, f.v.remarks);
  revalidatePath('/vendor-deboarding');
  revalidatePath('/approvals');
  return done('De-boarding request submitted for approval.');
}

const FIELD_LABEL: Record<keyof DeboardingFields, string> = {
  vendor_code: 'Vendor',
  vendor_name: 'Vendor name',
  reason: 'Reason',
  reason_other: 'Other reason',
  behaviour_score: 'Behaviour',
  work_style_score: 'Work style',
  quality_score: 'Quality',
  process_score: 'Process',
  pos_done: 'POs done',
  pos_late_15d: 'Late 15–29d',
  pos_late_1m: 'Late 30–60d',
  pos_late_over_1m: 'Late >60d',
  rejection_pct: 'Rejection %',
  resolvable: 'Resolvable',
  remarks: 'Remarks',
};

/**
 * Amend a de-boarding request (team / admin). HOUSE RULE: until it is approved, every field
 * can be changed. A request that was sent back or rejected goes back to the approval queue
 * when it is amended; a pending one stays pending with the new values. Approved = locked.
 */
export async function updateVendorDeboardingRequest(formData: FormData): Promise<ActionResult> {
  const user = await currentUser();
  if (!user) return fail('Not signed in.');
  if (!canEdit(user.role, 'draft')) {
    return fail('You do not have permission to change a de-boarding request.');
  }
  const id = Number(formData.get('id'));
  if (!Number.isInteger(id) || id <= 0) return fail('Invalid request.');
  const f = deboardingFields(formData);
  if (!f.ok) return fail(f.error);

  const supabase = await supa();
  const { data: row } = await supabase
    .from('sd_vendor_deboarding_request')
    .select(`id, status, ${Object.keys(FIELD_LABEL).join(', ')}`)
    .eq('id', id)
    .maybeSingle();
  if (!row) return fail('Request not found.');
  const old = row as unknown as Record<string, unknown>;
  const from = old.status as SdStatus;
  if (from === 'approved') {
    return fail('This request is approved, so it is locked. Ask the approver to reopen it to change it.');
  }

  const same = (a: unknown, b: unknown) =>
    typeof b === 'number' && a != null && a !== '' ? Number(a) === b : String(a ?? '') === String(b ?? '');
  const changes = (Object.keys(f.v) as (keyof DeboardingFields)[])
    .filter((k) => !same(old[k], f.v[k]))
    .map((k) => `${FIELD_LABEL[k]} ${old[k] ?? '—'} → ${f.v[k] ?? '—'}`);
  if (!changes.length) return fail('Nothing was changed.');

  const resubmit = from === 'rework' || from === 'rejected' || from === 'draft';
  const to: SdStatus = resubmit ? statusOnSubmit('vendor_deboarding') : from;

  // A rejected request is outside the one-live-request-per-vendor rule, so a newer request
  // for the same vendor may have been raised since. Changing the vendor can collide too.
  const { data: other } = await supabase
    .from('sd_vendor_deboarding_request')
    .select('id, status')
    .neq('id', id)
    .neq('status', 'rejected')
    .ilike('vendor_code', f.v.vendor_code.replace(/[%_\\]/g, (c) => `\\${c}`))
    .limit(1)
    .maybeSingle();
  if (other) {
    return fail(
      `Another de-boarding request for ${f.v.vendor_code} is already open (#${other.id}, ${String(other.status).replace('_', ' ')}). ` +
        'Amend that one instead.',
    );
  }

  const { data: saved, error } = await supabase
    .from('sd_vendor_deboarding_request')
    .update({ ...f.v, status: to })
    .eq('id', id)
    .neq('status', 'approved')
    .select('id')
    .maybeSingle();
  if (error) {
    return fail(
      error.code === '23505'
        ? `A de-boarding request for ${f.v.vendor_code} is already open. Amend that one instead.`
        : error.message,
    );
  }
  if (!saved) return fail('This request was approved meanwhile, so it is locked.');

  await writeLog(
    'vendor_deboarding',
    String(id),
    deboardLabel(f.v),
    from,
    to,
    user.email,
    `Amended: ${changes.join('; ')}${resubmit ? ' — resubmitted for approval' : ''}`,
  );
  revalidatePath('/vendor-deboarding');
  revalidatePath('/approvals');
  return done(`De-boarding request saved${resubmit ? ' and sent back for approval' : ''}.`);
}
