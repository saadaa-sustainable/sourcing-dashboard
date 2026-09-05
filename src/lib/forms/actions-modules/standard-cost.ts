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

export async function saveStandardCost(formData: FormData): Promise<ActionResult> {
  const user = await currentUser();
  if (!user) return fail('Not signed in.');
  if (!canEdit(user.role, 'draft')) {
    return fail('You do not have permission to edit standard costs.');
  }

  const product_code = String(formData.get('product_code') ?? '').trim();
  if (!product_code) return fail('Product code is required.');

  const supabase = await supa();
  const { data: existing } = await supabase
    .from('sd_standard_cost')
    .select('id, status, frozen')
    .eq('product_code', product_code)
    .maybeSingle();

  if (existing?.frozen) {
    return fail('This cost is frozen (a PO was issued) and can no longer be edited.');
  }
  const status = (existing?.status ?? 'draft') as SdStatus;
  if (!canEdit(user.role, status)) {
    return fail(
      status === 'approved'
        ? 'This cost is approved — resubmit to change it.'
        : 'You cannot edit this cost right now.',
    );
  }

  const patch: Record<string, unknown> = {
    product_code,
    job_cost: numOrNull(formData.get('job_cost')),
    fob_cost: numOrNull(formData.get('fob_cost')),
    efob_cost: numOrNull(formData.get('efob_cost')),
    total_po_avg_cost: numOrNull(formData.get('total_po_avg_cost')),
    cad_link: textOrNull(formData.get('cad_link')),
    rfp_link: textOrNull(formData.get('rfp_link')),
    fabric_code: textOrNull(formData.get('fabric_code')),
    // Saving is the act of documenting — clears the "data gap" flag.
    documented: true,
    updated_at: new Date().toISOString(),
  };
  // cm_cost is owned by the CMTP breakdown (saveCmtpComponents). Only touch it
  // when a caller explicitly sends it, so a header save never wipes the CMTP total.
  if (formData.has('cm_cost')) patch.cm_cost = numOrNull(formData.get('cm_cost'));
  const { data, error } = await supabase
    .from('sd_standard_cost')
    .upsert(patch, { onConflict: 'product_code' })
    .select('id')
    .single();
  if (error) return fail(`Could not save: ${error.message}`);

  revalidatePath('/standard-cost');
  return { ok: true, message: `Saved ${product_code}.`, id: data.id as number };
}

/**
 * Soft-delete / restore a Standard Cost product. Hiding removes it from the worklist
 * but keeps EVERYTHING — the cost row, lines, CMTP, rate history — untouched; only the
 * `hidden` flag flips. Restoring (re-adding via search) un-hides it, fully intact. This
 * is why re-adding routes here, NOT through saveStandardCost (which would overwrite).
 */
export async function setStandardCostHidden(formData: FormData): Promise<ActionResult> {
  const user = await currentUser();
  if (!user) return fail('Not signed in.');
  if (!canEdit(user.role, 'draft')) {
    return fail('You do not have permission to change the Standard Cost list.');
  }
  const product_code = String(formData.get('product_code') ?? '').trim();
  if (!product_code) return fail('Product code is required.');
  const hidden = formData.get('hidden') === 'true';
  const table = formData.get('track') === 'material' ? 'sd_material_standard_cost' : 'sd_standard_cost';

  const supabase = await supa();
  const { error } = await supabase
    .from(table)
    .update({ hidden, updated_at: new Date().toISOString() })
    .eq('product_code', product_code);
  if (error) return fail(`Could not ${hidden ? 'remove' : 'restore'}: ${error.message}`);

  revalidatePath('/standard-cost');
  return done(
    hidden
      ? `${product_code} removed from the list (its data is kept — add it again to restore).`
      : `${product_code} restored — all fields and history intact.`,
  );
}

/**
 * Replace the colour/size cost detail lines for one product (the expandable
 * "actual standard cost" the approver reviews). Marks the product documented.
 */
export async function saveStandardCostLines(formData: FormData): Promise<ActionResult> {
  const user = await currentUser();
  if (!user) return fail('Not signed in.');
  if (!canEdit(user.role, 'draft')) {
    return fail('You do not have permission to edit standard costs.');
  }
  const product_code = String(formData.get('product_code') ?? '').trim();
  if (!product_code) return fail('Product code is required.');

  let lines: {
    colour?: string;
    size?: string;
    consumption?: unknown;
    fabric_cost?: unknown;
    cm_cost?: unknown;
    total_cost?: unknown;
  }[] = [];
  try {
    lines = JSON.parse(String(formData.get('lines') ?? '[]'));
  } catch {
    lines = [];
  }

  const supabase = await supa();
  const { data: parent } = await supabase
    .from('sd_standard_cost')
    .select('id, frozen')
    .eq('product_code', product_code)
    .maybeSingle();
  if (parent?.frozen) return fail('This cost is frozen and can no longer be edited.');

  const clean = lines
    .map((l) => ({
      product_code,
      colour: textOrNull(l.colour),
      size: textOrNull(l.size),
      consumption: numOrNull(l.consumption),
      fabric_cost: numOrNull(l.fabric_cost),
      cm_cost: numOrNull(l.cm_cost),
      total_cost: numOrNull(l.total_cost),
    }))
    .filter(
      (l) =>
        l.colour ||
        l.size ||
        l.consumption != null ||
        l.fabric_cost != null ||
        l.cm_cost != null ||
        l.total_cost != null,
    );

  // Replace strategy: clear the product's lines, then insert the current set.
  await supabase.from('sd_standard_cost_line').delete().eq('product_code', product_code);
  if (clean.length) {
    const { error } = await supabase.from('sd_standard_cost_line').insert(clean);
    if (error) return fail(`Could not save lines: ${error.message}`);
  }
  // Ensure a parent row exists and is marked documented.
  await supabase
    .from('sd_standard_cost')
    .upsert(
      { product_code, documented: true, updated_at: new Date().toISOString() },
      { onConflict: 'product_code' },
    );

  revalidatePath('/standard-cost');
  return done(`Saved ${clean.length} cost line(s) for ${product_code}.`);
}

/**
 * Replace the CMTP (Cutting/Manufacturing/Trims/Packaging) breakdown for one
 * product. The sum of all line-item amounts becomes the product's CM cost
 * (sd_standard_cost.cm_cost) — the CMTP breakdown is the authoritative CM source.
 */
export async function saveCmtpComponents(formData: FormData): Promise<ActionResult> {
  const user = await currentUser();
  if (!user) return fail('Not signed in.');
  if (!canEdit(user.role, 'draft')) {
    return fail('You do not have permission to edit standard costs.');
  }
  const product_code = String(formData.get('product_code') ?? '').trim();
  if (!product_code) return fail('Product code is required.');

  let rows: { category?: string; label?: string; amount?: unknown }[] = [];
  try {
    rows = JSON.parse(String(formData.get('components') ?? '[]'));
  } catch {
    rows = [];
  }

  const supabase = await supa();
  const { data: parent } = await supabase
    .from('sd_standard_cost')
    .select('id, frozen, cm_cost')
    .eq('product_code', product_code)
    .maybeSingle();
  if (parent?.frozen) return fail('This cost is frozen and can no longer be edited.');

  // Keep only rows that carry a head; drop fully-empty scratch rows.
  const clean = rows
    .map((r, i) => ({
      product_code,
      category: String(r.category ?? '').trim(),
      label: textOrNull(r.label),
      amount: numOrNull(r.amount),
      position: i,
    }))
    .filter((r) => r.category && (r.label != null || r.amount != null));

  const total = clean.reduce((s, r) => s + (r.amount ?? 0), 0);

  // Item 2 — line-item revision with mandatory reason. Diff the incoming lines
  // against what's on file (keyed by head + sub-item). If this is a REVISION of an
  // existing breakdown (rows already existed) and any line's amount moved / a line
  // was added or removed, the reviser must say why — that reason is logged per
  // changed line to sd_cmtp_revision (old → new, who, when), the audit trail shown
  // in Rate History. First-time entry needs no reason.
  const { data: existing } = await supabase
    .from('sd_cmtp_component')
    .select('category, label, amount')
    .eq('product_code', product_code);
  const lineKey = (cat: string, label: string | null) => cat + ' :: ' + (label ?? '');
  const oldByKey = new Map<string, number | null>(
    (existing ?? []).map((r) => [lineKey(String(r.category), textOrNull(r.label)), numOrNull(r.amount)]),
  );
  const amtEq = (a: number | null, b: number | null) =>
    (a == null && b == null) || (a != null && b != null && Math.abs(a - b) < 0.005);
  type LineChange = { category: string; label: string | null; old: number | null; next: number | null };
  const changes: LineChange[] = [];
  const seen = new Set<string>();
  for (const r of clean) {
    const k = lineKey(r.category, r.label);
    seen.add(k);
    const old = oldByKey.has(k) ? oldByKey.get(k) ?? null : null;
    if (!oldByKey.has(k) || !amtEq(old, r.amount)) {
      changes.push({ category: r.category, label: r.label, old, next: r.amount });
    }
  }
  for (const r of existing ?? []) {
    const k = lineKey(String(r.category), textOrNull(r.label));
    if (!seen.has(k)) {
      changes.push({ category: String(r.category), label: textOrNull(r.label), old: numOrNull(r.amount), next: null });
    }
  }
  const isRevision = (existing?.length ?? 0) > 0 && changes.length > 0;
  const reason = String(formData.get('revision_reason') ?? '').trim();
  if (isRevision && !reason) {
    return fail(
      'This changes an existing CMTP breakdown — enter a reason for the revision (e.g. "karigar rate increased"). It is logged in the rate history.',
    );
  }

  // Replace strategy: clear the product's CMTP rows, then insert the current set.
  await supabase.from('sd_cmtp_component').delete().eq('product_code', product_code);
  if (clean.length) {
    const { error } = await supabase.from('sd_cmtp_component').insert(clean);
    if (error) return fail(`Could not save CMTP breakdown: ${error.message}`);
  }

  // Append the line-level revision audit (best-effort — never blocks the save).
  if (isRevision) {
    const cmBefore = parent?.cm_cost == null ? null : Number(parent.cm_cost);
    const cmAfter = clean.length ? total : null;
    await supabase.from('sd_cmtp_revision').insert(
      changes.map((c) => ({
        product_code,
        category: c.category,
        label: c.label,
        old_amount: c.old,
        new_amount: c.next,
        cm_before: cmBefore,
        cm_after: cmAfter,
        reason,
        revised_by: user.email,
      })),
    );
  }

  // CMTP total is the CM cost. Saving is documenting — clears the data-gap flag.
  const { error: upErr } = await supabase.from('sd_standard_cost').upsert(
    {
      product_code,
      cm_cost: clean.length ? total : null,
      documented: true,
      updated_at: new Date().toISOString(),
    },
    { onConflict: 'product_code' },
  );
  if (upErr) return fail(`Could not save CM cost: ${upErr.message}`);

  revalidatePath('/standard-cost');
  return done(`Saved CMTP breakdown for ${product_code} — CM ${total}.`);
}

/**
 * Add a new standardized sub-item to the CMTP master under a head. Managed +
 * addable (team/admin) rather than a hardcoded enum, so a genuinely new sub-item
 * can be introduced without a code change — recorded with who added it. A name
 * that already exists in the head is a no-op (keeps the list de-duplicated).
 */
export async function addCmtpSubitem(formData: FormData): Promise<ActionResult> {
  const user = await currentUser();
  if (!user) return fail('Not signed in.');
  if (!canEdit(user.role, 'draft')) {
    return fail('You do not have permission to add CMTP sub-items.');
  }
  const category = String(formData.get('category') ?? '').trim();
  const name = String(formData.get('name') ?? '').trim();
  if (!category || !name) return fail('Both a head and a sub-item name are required.');

  const supabase = await supa();
  const { error } = await supabase
    .from('sd_cmtp_subitem')
    .upsert(
      { category, name, created_by: user.email },
      { onConflict: 'category,name', ignoreDuplicates: true },
    );
  if (error) return fail(`Could not add sub-item: ${error.message}`);

  revalidatePath('/standard-cost');
  return done(`Added “${name}” under ${category}.`);
}

export async function submitStandardCost(formData: FormData): Promise<ActionResult> {
  const user = await currentUser();
  if (!user) return fail('Not signed in.');

  const id = Number(formData.get('id'));
  if (!id) return fail('Save the cost before submitting it.');

  const supabase = await supa();
  const { data: row } = await supabase
    .from('sd_standard_cost')
    .select('id, product_code, status, frozen, job_cost, fob_cost, efob_cost')
    .eq('id', id)
    .maybeSingle();
  if (!row) return fail('Cost not found.');
  if (row.frozen) return fail('This cost is frozen and cannot be resubmitted.');
  if (!canSubmit(user.role, row.status as SdStatus)) {
    return fail('This cost cannot be submitted from its current state.');
  }
  if (row.job_cost == null && row.fob_cost == null && row.efob_cost == null) {
    return fail('Enter at least one rate before submitting.');
  }

  const next = statusOnSubmit('standard_cost');
  const { data: updated, error } = await supabase
    .from('sd_standard_cost')
    .update({
      status: next,
      submitted_by: user.email,
      submitted_at: new Date().toISOString(),
      rejection_notes: null,
    })
    .eq('id', id)
    .in('status', ['draft', 'rework'])
    .select('id');
  if (error) return fail(error.message);
  if (!updated?.length) return fail('Already submitted by someone else.');

  await writeLog(
    'standard_cost',
    String(id),
    `Standard cost — ${row.product_code}`,
    'draft',
    next,
    user.email,
  );
  revalidatePath('/standard-cost');
  revalidatePath('/approvals');
  return done('Submitted for approval.');
}

/* ------------------------------------------------------------------ */
/* Material standard cost — parallel sheet for raw/dyed/trim materials  */
/* ------------------------------------------------------------------ */

export async function saveMaterialCost(formData: FormData): Promise<ActionResult> {
  const user = await currentUser();
  if (!user) return fail('Not signed in.');
  if (!canEdit(user.role, 'draft')) {
    return fail('You do not have permission to edit material costs.');
  }

  const product_code = String(formData.get('product_code') ?? '').trim().toUpperCase();
  if (!product_code) return fail('Material code is required.');

  const supabase = await supa();
  const { data: existing } = await supabase
    .from('sd_material_standard_cost')
    .select('id, status, frozen')
    .eq('product_code', product_code)
    .maybeSingle();

  if (existing?.frozen) {
    return fail('This cost is frozen and can no longer be edited.');
  }
  const status = (existing?.status ?? 'draft') as SdStatus;
  if (!canEdit(user.role, status)) {
    return fail(
      status === 'approved'
        ? 'This cost is approved — resubmit to change it.'
        : 'You cannot edit this cost right now.',
    );
  }

  const patch = {
    product_code,
    job_cost: numOrNull(formData.get('job_cost')),
    fob_cost: numOrNull(formData.get('fob_cost')),
    updated_at: new Date().toISOString(),
  };
  const { data, error } = await supabase
    .from('sd_material_standard_cost')
    .upsert(patch, { onConflict: 'product_code' })
    .select('id')
    .single();
  if (error) return fail(`Could not save: ${error.message}`);

  revalidatePath('/standard-cost');
  revalidatePath('/buying-plan');
  return { ok: true, message: `Saved ${product_code}.`, id: data.id as number };
}

export async function submitMaterialCost(formData: FormData): Promise<ActionResult> {
  const user = await currentUser();
  if (!user) return fail('Not signed in.');

  const id = Number(formData.get('id'));
  if (!id) return fail('Save the cost before submitting it.');

  const supabase = await supa();
  const { data: row } = await supabase
    .from('sd_material_standard_cost')
    .select('id, product_code, status, frozen, job_cost, fob_cost')
    .eq('id', id)
    .maybeSingle();
  if (!row) return fail('Cost not found.');
  if (row.frozen) return fail('This cost is frozen and cannot be resubmitted.');
  if (!canSubmit(user.role, row.status as SdStatus)) {
    return fail('This cost cannot be submitted from its current state.');
  }
  if (row.job_cost == null && row.fob_cost == null) {
    return fail('Enter a Job Work or Purchase rate before submitting.');
  }

  const next = statusOnSubmit('material_cost');
  const { data: updated, error } = await supabase
    .from('sd_material_standard_cost')
    .update({
      status: next,
      submitted_by: user.email,
      submitted_at: new Date().toISOString(),
      rejection_notes: null,
    })
    .eq('id', id)
    .in('status', ['draft', 'rework'])
    .select('id');
  if (error) return fail(error.message);
  if (!updated?.length) return fail('Already submitted by someone else.');

  await writeLog(
    'material_cost',
    String(id),
    `Material cost — ${row.product_code}`,
    'draft',
    next,
    user.email,
  );
  revalidatePath('/standard-cost');
  revalidatePath('/approvals');
  return done('Submitted for approval.');
}

/* ------------------------------------------------------------------ */
/* Cost negotiation — its own process (propose → target → actual →     */
/* sign-off), on either the FG or the material cost sheet.             */
/* ------------------------------------------------------------------ */

