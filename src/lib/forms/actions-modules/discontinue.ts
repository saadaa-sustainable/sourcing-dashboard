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

type DiscontinueFields = {
  scope: 'size' | 'colour' | 'product';
  product_code: string;
  product_variant: string | null;
  size: string | null;
  reason: string | null;
};

/** The user-entered fields of a discontinue request, read and checked from a form. */
function discontinueFields(
  formData: FormData,
): { ok: true; v: DiscontinueFields; label: string } | { ok: false; error: string } {
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

  if (!productCode) return { ok: false, error: 'Pick a product code.' };
  if (scope !== 'product' && !variant) return { ok: false, error: 'Pick a colour (variant).' };
  if (scope === 'size' && !size) return { ok: false, error: 'Pick a size to discontinue.' };

  const label =
    scope === 'product'
      ? `Product ${productCode}`
      : scope === 'size'
        ? `${productCode} / ${variant} / ${size}`
        : `${productCode} / ${variant}`;
  return {
    ok: true,
    v: { scope, product_code: productCode, product_variant: variant, size, reason: reason || null },
    label,
  };
}

export async function createDiscontinueRequest(
  formData: FormData,
): Promise<ActionResult> {
  const user = await currentUser();
  if (!user) return fail('Not signed in.');
  if (!canEdit(user.role, 'draft')) {
    return fail('You do not have permission to raise a discontinue request.');
  }

  const f = discontinueFields(formData);
  if (!f.ok) return fail(f.error);
  const { scope, product_code: productCode, product_variant: variant, size } = f.v;
  const reason = f.v.reason ?? '';
  const label = f.label;

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

/**
 * Amend a discontinue request (team / admin). HOUSE RULE: until it is approved, every field
 * can be changed. A request that was sent back or rejected goes back to the approval queue
 * when it is amended; a pending one stays pending with the new values. Approved = locked.
 */
export async function updateDiscontinueRequest(formData: FormData): Promise<ActionResult> {
  const user = await currentUser();
  if (!user) return fail('Not signed in.');
  if (!canEdit(user.role, 'draft')) {
    return fail('You do not have permission to change a discontinue request.');
  }
  const id = Number(formData.get('id'));
  if (!Number.isInteger(id) || id <= 0) return fail('Invalid request.');
  const f = discontinueFields(formData);
  if (!f.ok) return fail(f.error);

  const supabase = await supa();
  const { data: row } = await supabase
    .from('sd_discontinue_request')
    .select('id, scope, product_code, product_variant, size, reason, status')
    .eq('id', id)
    .maybeSingle();
  if (!row) return fail('Request not found.');
  const from = row.status as SdStatus;
  if (from === 'approved') {
    return fail('This request is approved, so it is locked. Ask the approver to reopen it to change it.');
  }

  const labels: Record<keyof DiscontinueFields, string> = {
    scope: 'Scope',
    product_code: 'Product',
    product_variant: 'Colour',
    size: 'Size',
    reason: 'Reason',
  };
  const old = row as Record<string, unknown>;
  const changes = (Object.keys(f.v) as (keyof DiscontinueFields)[])
    .filter((k) => String(old[k] ?? '') !== String(f.v[k] ?? ''))
    .map((k) => `${labels[k]} ${old[k] ?? '—'} → ${f.v[k] ?? '—'}`);
  if (!changes.length) return fail('Nothing was changed.');

  const resubmit = from === 'rework' || from === 'rejected' || from === 'draft';
  const to: SdStatus = resubmit ? statusOnSubmit('discontinue') : from;

  // A rejected request is outside the one-live-request rule, so another request for the same
  // thing may have been raised since. Changing the target can collide the same way.
  let clash = supabase
    .from('sd_discontinue_request')
    .select('id, status')
    .neq('id', id)
    .neq('status', 'rejected')
    .eq('scope', f.v.scope)
    .eq('product_code', f.v.product_code);
  clash = f.v.product_variant == null ? clash.is('product_variant', null) : clash.eq('product_variant', f.v.product_variant);
  clash = f.v.size == null ? clash.is('size', null) : clash.eq('size', f.v.size);
  const { data: other } = await clash.limit(1).maybeSingle();
  if (other) {
    return fail(
      `Another ${f.v.scope}-level request for ${f.label} is already live (#${other.id}, ${String(other.status).replace('_', ' ')}). ` +
        'Amend that one instead.',
    );
  }

  const { data: saved, error } = await supabase
    .from('sd_discontinue_request')
    .update({ ...f.v, status: to })
    .eq('id', id)
    .neq('status', 'approved')
    .select('id')
    .maybeSingle();
  if (error) {
    return fail(
      error.code === '23505'
        ? `A live ${f.v.scope}-level request already exists for ${f.label}. Amend that one instead.`
        : error.message,
    );
  }
  if (!saved) return fail('This request was approved meanwhile, so it is locked.');

  await writeLog(
    'discontinue',
    String(id),
    `Discontinue ${f.v.scope} — ${f.label}`,
    from,
    to,
    user.email,
    `Amended: ${changes.join('; ')}${resubmit ? ' — resubmitted for approval' : ''}`,
  );
  revalidatePath('/discontinue');
  revalidatePath('/approvals');
  return done(`Discontinue request saved${resubmit ? ' and sent back for approval' : ''}.`);
}

/* ================================================================== */
/* Shared approve / reject                                             */
/* ================================================================== */

