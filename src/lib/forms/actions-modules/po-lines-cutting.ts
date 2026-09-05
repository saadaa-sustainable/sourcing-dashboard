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

export async function savePoLines(formData: FormData): Promise<ActionResult> {
  const user = await currentUser();
  if (!user) return fail('Not signed in.');
  if (!canEdit(user.role, 'draft')) return fail('You do not have permission to edit PO lines.');
  const poId = Number(formData.get('po_id'));
  if (!poId) return fail('Invalid PO.');
  let lines: { product_variant?: string; size?: string; qty?: number }[] = [];
  try {
    lines = JSON.parse(String(formData.get('lines') ?? '[]'));
  } catch {
    lines = [];
  }
  const clean = lines
    .map((l) => ({
      product_variant: String(l.product_variant ?? '').trim() || null,
      size: String(l.size ?? '').trim() || null,
      qty: Number(l.qty) || 0,
    }))
    .filter((l) => l.product_variant || l.qty);
  const supabase = await supa();
  const { data: po } = await supabase.from('sd_po_approval').select('status').eq('id', poId).maybeSingle();
  if (!po) return fail('PO not found.');
  if (po.status === 'approved') return fail('An approved PO cannot have its lines changed.');
  await supabase.from('sd_po_approval_line').delete().eq('po_id', poId);
  if (clean.length) {
    const { error } = await supabase
      .from('sd_po_approval_line')
      .insert(clean.map((l) => ({ po_id: poId, ...l })));
    if (error) return fail(error.message);
  }
  // PO qty is the sum of the size lines — never typed by hand.
  const poQty = clean.reduce((sum, l) => sum + (Number(l.qty) || 0), 0);
  await supabase.from('sd_po_approval').update({ po_qty: poQty }).eq('id', poId);
  revalidatePath('/po-approval');
  revalidatePath('/approvals');
  return done(`Saved ${clean.length} line(s) · PO qty ${poQty}.`);
}

/** Row-wise PO closure (Yes/No) on the submission/closure table. */
export async function setPoClosure(formData: FormData): Promise<ActionResult> {
  const user = await currentUser();
  if (!user) return fail('Not signed in.');
  if (!canEdit(user.role, 'draft')) return fail('You do not have permission to close POs.');
  const po_number = String(formData.get('po_number') ?? '').trim();
  if (!po_number) return fail('Invalid PO.');
  const decision = String(formData.get('decision') ?? '');
  const status: SdStatus = decision === 'yes' ? 'approved' : decision === 'no' ? 'rejected' : 'draft';

  const supabase = await supa();
  const { error } = await supabase.from('sd_po_closure_decision').upsert(
    {
      po_number,
      status,
      decided_by: user.email,
      decided_at: new Date().toISOString(),
      note: textOrNull(formData.get('note')),
      updated_at: new Date().toISOString(),
    },
    { onConflict: 'po_number' },
  );
  if (error) return fail(`Could not save: ${error.message}`);
  revalidatePath('/po-approval');
  return done(status === 'approved' ? 'PO marked closed.' : status === 'rejected' ? 'PO flagged.' : 'Saved.');
}

/* ================================================================== */
/* Cutting Register & dynamic links (PO Closure feature)               */
/* ================================================================== */

// product_code is encoded in po_ref_num: FY.../<TYPE>/<PRODUCT>/<VENDOR>-<SEQ>.
const productFromPoRef = (po: string) => {
  const parts = po.split('/');
  return parts[2]?.trim() || null;
};

/**
 * Authenticated Cutting Register entry. Snapshots the product's BOM standard at
 * creation time (spec §3) — reads it fresh from sd_product_master so the record
 * reflects the standard as it was at cutting, not a stale client value.
 */
export async function saveCuttingRegister(formData: FormData): Promise<ActionResult> {
  const user = await currentUser();
  if (!user) return fail('Not signed in.');
  if (!canEdit(user.role, 'draft')) return fail('You do not have permission to add cutting entries.');

  const po_ref_num = String(formData.get('po_ref_num') ?? '').trim();
  if (!po_ref_num) return fail('Enter the PO reference.');
  const actual = numOrNull(formData.get('actual_consumption_qty'));
  if (actual == null) return fail('Enter the actual consumption.');

  const product_code = productFromPoRef(po_ref_num);
  const supabase = await supa();

  // Snapshot BOM from the master (null when there's no BOM on file — never 0).
  let bomQ: number | null = null;
  let bomU: string | null = null;
  if (product_code) {
    const { data: pm } = await supabase
      .from('sd_product_master')
      .select('bom_quantity, bom_uom')
      .eq('product_code', product_code)
      .maybeSingle();
    bomQ = pm?.bom_quantity ?? null;
    bomU = pm?.bom_uom ?? null;
  }

  const { error } = await supabase.from('sd_cutting_register').insert({
    po_ref_num,
    product_code,
    bom_standard_qty: bomQ,
    bom_uom: bomU,
    actual_consumption_qty: actual,
    cutting_date: dateOrNull(formData.get('cutting_date')),
    remarks: textOrNull(formData.get('remarks')),
    submitted_via: 'dashboard',
    submitted_by_email: user.email,
  });
  if (error) return fail(`Could not save: ${error.message}`);
  revalidatePath('/cutting-register');
  return done(`Saved cutting entry for ${po_ref_num}.`);
}

export async function generateDynamicLink(formData: FormData): Promise<LinkResult> {
  const user = await currentUser();
  if (!user) return { ok: false, error: 'Not signed in.' };
  if (!canEdit(user.role, 'draft')) return { ok: false, error: 'You do not have permission to generate links.' };

  const po_ref_num = String(formData.get('po_ref_num') ?? '').trim();
  if (!po_ref_num) return { ok: false, error: 'Enter the PO reference.' };

  const token = randomBytes(24).toString('base64url');
  const supabase = await supa();

  const { data: closure } = await supabase
    .from('sd_po_closure')
    .select('easycom_completed_at')
    .eq('po_ref_num', po_ref_num)
    .maybeSingle();

  const now = Date.now();
  let expires = now + 30 * 86_400_000;
  if (closure?.easycom_completed_at) {
    expires = Math.min(expires, Date.parse(closure.easycom_completed_at) + 15 * 86_400_000);
  }
  // A PO completed more than 15 days ago yields an expiry in the past — the link
  // would be born dead. Refuse and explain rather than silently issue a useless
  // token. (15-day post-completion window is the cutting-register sign-off SLA.)
  if (expires <= now) {
    return {
      ok: false,
      error:
        'This PO was completed more than 15 days ago, so a link would already be expired. ' +
        'Links are only valid for 15 days after EasyCom completion.',
    };
  }
  const expiresAt = new Date(expires).toISOString();

  const { error } = await supabase.from('sd_dynamic_links').insert({
    token,
    link_type: 'cutting_register',
    po_ref_num,
    created_by: user.email,
    expires_at: expiresAt,
  });
  if (error) return { ok: false, error: `Could not generate link: ${error.message}` };
  revalidatePath('/cutting-register');
  return { ok: true, token, expiresAt };
}

/** Revoke an open link (spec §2) — needed if it was sent to the wrong person. */
export async function revokeDynamicLink(formData: FormData): Promise<ActionResult> {
  const user = await currentUser();
  if (!user) return fail('Not signed in.');
  if (!canEdit(user.role, 'draft')) return fail('You do not have permission to revoke links.');
  const id = Number(formData.get('id'));
  if (!id) return fail('Invalid link.');
  const supabase = await supa();
  const { error } = await supabase.from('sd_dynamic_links').update({ is_active: false }).eq('id', id);
  if (error) return fail(`Could not revoke: ${error.message}`);
  revalidatePath('/cutting-register');
  return done('Link revoked.');
}

/**
 * Public submission from the /fill/[token] route (no login). Runs as anon and only
 * calls the SECURITY DEFINER RPC, which re-validates the token, snapshots the BOM,
 * inserts the register row, and burns the link (single-use).
 */
export async function submitCuttingViaLink(formData: FormData): Promise<ActionResult> {
  const token = String(formData.get('token') ?? '').trim();
  const name = String(formData.get('name') ?? '').trim();
  const contact = String(formData.get('contact') ?? '').trim();
  const actual = numOrNull(formData.get('actual_consumption_qty'));
  if (!token) return fail('Invalid link.');
  if (!name || !contact) return fail('Enter your name and email/phone.');
  if (actual == null) return fail('Enter the actual consumption.');

  const supabase = createPublicClient();
  const { data, error } = await supabase.rpc('sd_submit_cutting_register', {
    p_token: token,
    p_actual: actual,
    p_cutting_date: dateOrNull(formData.get('cutting_date')),
    p_remarks: textOrNull(formData.get('remarks')),
    p_name: name,
    p_email: contact,
  });
  if (error) return fail('Could not submit — this link may no longer be active.');
  if (data === false) return fail('This link is no longer active.');
  return done('Submitted — thank you!');
}

/* ================================================================== */
/* PO Closure — gating + two-leg workflow + surplus (spec §4-5)        */
/* ================================================================== */

/** Begin closure. Gated: only a completed PO (closure row carries the stamp). */
