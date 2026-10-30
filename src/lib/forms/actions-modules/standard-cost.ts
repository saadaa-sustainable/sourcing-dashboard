'use server';

import { loadNpdOptions, loadNpdProduct, NpdNotConfiguredError, type NpdOption } from '@/lib/npd-tracker.server';
import { revalidatePath } from 'next/cache';
import { canEdit, canSubmit, statusOnSubmit } from '../approval';
import { currentUser } from '../queries';
import { pageAll } from '../queries-modules/_shared';
import type { SdStatus } from '../types';
import {
  done,
  fail,
  numOrNull,
  supa,
  writeLog,
  type ActionResult,
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

  if (existing || ['job_cost','fob_cost','efob_cost','cm_cost','fabric_code','cad_link','rfp_link','total_po_avg_cost'].some(key => formData.has(key))) return fail('Use the Standard Cost submission / amendment workflow on the product page.');

  // A NEW cost row must be an EasyEcom product or a temporary (TMP-xxxx) one: a typed name
  // ("ABCD") is never a product code. New products not in EasyEcom go through mintTempProduct.
  if (!existing) {
    const [{ data: inCatalog }, { data: temp }] = await Promise.all([
      supabase.from('sd_product_catalog').select('product_code').eq('product_code', product_code.toUpperCase()).maybeSingle(),
      supabase.from('sd_temp_product').select('temp_code').eq('temp_code', product_code).eq('status', 'active').maybeSingle(),
    ]);
    if (!inCatalog && !temp) {
      return fail(`${product_code} is not in EasyEcom. Create it as a new product instead: it gets a temporary TMP ID you can link later.`);
    }
  }
  // Adding a product creates only a blank worklist row. Cost content is staged separately.
  const patch = { product_code, documented: false, updated_at: new Date().toISOString() };
  const { data, error } = await supabase
    .from('sd_standard_cost')
    .insert(patch)
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
  void formData;
  return fail('Use the Standard Cost submission / amendment workflow on the product page.');
}

/**
 * Replace the CMTP (Cutting/Manufacturing/Trims/Packaging) breakdown for one
 * product. The sum of all line-item amounts becomes the product's CM cost
 * (sd_standard_cost.cm_cost) — the CMTP breakdown is the authoritative CM source.
 */
export async function saveCmtpComponents(formData: FormData): Promise<ActionResult> {
  void formData;
  return fail('Use the Standard Cost submission / amendment workflow on the product page.');
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
  void formData;
  return fail('Use the Standard Cost submission / amendment workflow on the product page.');
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

  // Only touch a rate when the form actually sent it — re-adding an existing code
  // from the "Add a material code" box must not null out its rates (FG twin does
  // the same).
  const patch: Record<string, unknown> = { product_code, updated_at: new Date().toISOString() };
  if (formData.has('job_cost')) patch.job_cost = numOrNull(formData.get('job_cost'));
  if (formData.has('fob_cost')) patch.fob_cost = numOrNull(formData.get('fob_cost'));
  if (formData.has('efob_cost')) patch.efob_cost = numOrNull(formData.get('efob_cost'));
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
    .in('status', ['draft', 'rework', 'rejected'])
    .select('id');
  if (error) return fail(error.message);
  if (!updated?.length) return fail('Already submitted by someone else.');

  await writeLog(
    'material_cost',
    String(id),
    `Material cost — ${row.product_code}`,
    row.status as SdStatus,
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

/* ------------------------------------------------------------------ */
/* Temporary products — a product not yet in EasyEcom gets a minted    */
/* TMP-xxxx code here, usable across Buying Plan / PO, and later merged */
/* into the real code when it appears.                                 */
/* ------------------------------------------------------------------ */

/**
 * Typing a name to create a product is RETIRED (user, 2026-10-09): a product not in EasyEcom is
 * added only from NPD Tracker V7 (addNpdProduct), so every new product has a record. Kept as a
 * refusal so an old open tab gets a clear answer instead of a silent TMP code.
 */
export async function mintTempProduct(_formData: FormData): Promise<ActionResult> {
  void _formData;
  return fail('New products are no longer created by typing a name. Pick the product from NPD Tracker V7 instead.');
}

/** The NPD Tracker V7 products that can be (or why they cannot be) added to Standard Cost. */
export async function listNpdProducts(): Promise<{ ok: true; options: NpdOption[] } | { ok: false; error: string }> {
  const user = await currentUser();
  if (!user) return { ok: false, error: 'Not signed in.' };
  if (!canEdit(user.role, 'draft')) return { ok: false, error: 'You do not have permission to add products.' };
  const supabase = await supa();
  try {
    const [sheet, catalog, temps] = await Promise.all([
      pageAll<{ product_code: string }>(() => supabase.from('sd_standard_cost').select('product_code').order('product_code')),
      pageAll<{ product_code: string }>(() => supabase.from('sd_product_catalog').select('product_code').order('product_code')),
      pageAll<{ npd_product_id: number | null }>(() =>
        supabase.from('sd_temp_product').select('npd_product_id').eq('status', 'active').not('npd_product_id', 'is', null).order('temp_code'),
      ),
    ]);
    const options = await loadNpdOptions({
      onSheet: new Set(sheet.map((r) => String(r.product_code).toUpperCase())),
      inEasyEcom: new Set(catalog.map((r) => String(r.product_code).toUpperCase())),
      npdRegistered: new Set(temps.map((r) => Number(r.npd_product_id))),
    });
    return { ok: true, options };
  } catch (e) {
    if (e instanceof NpdNotConfiguredError) return { ok: false, error: e.message };
    return { ok: false, error: `Could not read NPD Tracker V7: ${e instanceof Error ? e.message : String(e)}` };
  }
}

/**
 * Add an NPD Tracker V7 product to Standard Cost under its NPD ITEM CODE (upper-cased). The NPD row
 * is re-read here (never trusted from the browser); the registry keeps the NPD id, SKU code (for
 * PO Approval's SKU quantities), category, status and type as the record of where it came from.
 */
export async function addNpdProduct(formData: FormData): Promise<ActionResult> {
  const user = await currentUser();
  if (!user) return fail('Not signed in.');
  if (!canEdit(user.role, 'draft')) return fail('You do not have permission to add products.');
  const id = Number(formData.get('npd_id'));
  if (!Number.isInteger(id) || id <= 0) return fail('Pick a product from NPD Tracker V7.');

  let found;
  try {
    found = await loadNpdProduct(id);
  } catch (e) {
    return fail(e instanceof Error ? e.message : String(e));
  }
  if (!found) return fail('That product is not on NPD Tracker V7 any more, or it is already launched.');
  const { row, duplicates } = found;
  if (!row.item_code) return fail('This NPD product has no item code yet. Add it on NPD Tracker V7 first.');
  if (duplicates > 1) return fail(`Item code ${row.item_code} is used by ${duplicates} NPD products. Fix it on NPD Tracker V7 first.`);

  const supabase = await supa();
  const { data: code, error } = await supabase.rpc('sd_register_npd_product', {
    p_item_code: row.item_code,
    p_sku_code: row.sku_code,
    p_name: row.product_name ?? row.item_code,
    p_npd_id: row.id,
    p_category: row.category,
    p_status: row.status,
    p_type: row.product_type,
    p_by: user.email,
  });
  if (error || !code) return fail(error?.message ?? 'Could not add the NPD product.');

  // Seed its Standard Cost row so it shows on the sheet ready to be costed.
  const { data: sc, error: scErr } = await supabase
    .from('sd_standard_cost')
    .upsert({ product_code: code, documented: false, updated_at: new Date().toISOString() }, { onConflict: 'product_code' })
    .select('id')
    .maybeSingle();
  if (scErr) return fail(`Added ${code} but could not create its cost row: ${scErr.message}`);

  await writeLog(
    'standard_cost',
    String(sc?.id ?? code),
    `Standard cost — ${code}`,
    null,
    'draft',
    user.email,
    `Added from NPD Tracker V7: ${row.product_name ?? code}${row.sku_code ? ` · SKU ${row.sku_code}` : ''}${row.category ? ` · ${row.category}` : ''}`,
  );
  revalidatePath('/standard-cost');
  return { ok: true, message: `Added ${code} — “${row.product_name ?? code}” from NPD Tracker V7. Fill its cost next.` };
}

/** Merge a temporary product into its real EasyEcom code (admin) — atomic repoint. */
export async function mergeTempProduct(formData: FormData): Promise<ActionResult> {
  const user = await currentUser();
  if (!user) return fail('Not signed in.');
  if (user.role !== 'admin') return fail('Only an admin can merge a temporary product.');

  const temp_code = String(formData.get('temp_code') ?? '').trim();
  const real_code = String(formData.get('real_code') ?? '').trim().toUpperCase();
  if (!temp_code || !real_code) return fail('Both the temporary product and the real product code are required.');
  if (temp_code === real_code) return fail('The temporary and real codes must differ.');

  const supabase = await supa();
  const { error } = await supabase.rpc('sd_merge_temp_product', {
    p_temp: temp_code,
    p_real: real_code,
    p_by: user.email,
  });
  if (error) return fail(error.message);

  revalidatePath('/standard-cost');
  revalidatePath('/buying-plan');
  revalidatePath('/po-approval');
  return { ok: true, message: `Merged ${temp_code} into ${real_code}. All its cost, plan and PO data now lives under ${real_code}.` };
}


/* ------------------------------------------------------------------ */
/* Products not in EasyEcom — typed codes ("ABCD") and TMP-xxxx alike   */
/* ------------------------------------------------------------------ */

/**
 * Link a product that is not in EasyEcom to its EasyEcom product code: its cost, cost sheet,
 * rate history, plan lines and POs all move to the real code (sd_link_product, one
 * transaction; the database itself checks the caller is an admin).
 */
export async function linkProductToEasyEcom(formData: FormData): Promise<ActionResult> {
  const user = await currentUser();
  if (!user) return fail('Not signed in.');
  if (user.role !== 'admin') return fail('Only an admin can link a product to EasyEcom.');
  const from = String(formData.get('product_code') ?? '').trim();
  const to = String(formData.get('real_code') ?? '').trim().toUpperCase();
  if (!from || !to) return fail('Pick the EasyEcom product to link to.');
  // When the EasyEcom product already has its own cost: the rates (and cost sheet) the admin
  // chose to keep, as JSON from the merge panel.
  let merge: Record<string, unknown> | null = null;
  const rawMerge = formData.get('merge');
  if (rawMerge) {
    try {
      merge = JSON.parse(String(rawMerge));
    } catch {
      return fail('Could not read the chosen rates.');
    }
  }

  const supabase = await supa();
  const { error } = await supabase.rpc('sd_link_product', { p_from: from, p_to: to, p_by: user.email, p_merge: merge as never });
  if (error) return fail(error.message);

  revalidatePath('/standard-cost');
  revalidatePath('/buying-plan');
  revalidatePath('/po-approval');
  return {
    ok: true,
    message: merge
      ? `Merged ${from} into ${to} with the rates you chose. Its plan lines and POs now sit under ${to}.`
      : `Linked ${from} to ${to}. Its cost, plan lines and POs now sit under ${to}.`,
  };
}

/**
 * Delete a product that is not in EasyEcom, with its cost sheet. The database refuses while a
 * PO, plan line, inward or cutting record still uses it (link it instead), once it is frozen,
 * and for a signed-off cost unless the caller is an admin. Deleted rows stay in the audit log.
 */
export async function deleteUnlinkedProduct(formData: FormData): Promise<ActionResult> {
  const user = await currentUser();
  if (!user) return fail('Not signed in.');
  if (!canEdit(user.role, 'draft')) return fail('You do not have permission to delete products.');
  const code = String(formData.get('product_code') ?? '').trim();
  if (!code) return fail('Product code is required.');

  const supabase = await supa();
  const { error } = await supabase.rpc('sd_delete_unlinked_product', { p_code: code, p_by: user.email });
  if (error) return fail(error.message);

  revalidatePath('/standard-cost');
  return { ok: true, message: `Deleted ${code}.` };
}
