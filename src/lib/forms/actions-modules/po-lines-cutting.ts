'use server';

import { randomBytes } from 'crypto';
import { revalidatePath } from 'next/cache';
import { createClient, hasSupabaseEnv } from '@/lib/supabase/server';
import { createAdminClient, hasSupabaseAdminEnv } from '@/lib/supabase/admin';
import { createPublicClient } from '@/lib/supabase/public';
import { computeClosureCompliance } from '@/lib/business-logic';
import { recomputeExpectedCost } from '@/lib/standard-cost';
import { pushCuttingRegisterRow, reconcileCuttingToBq, pushCuttingViaAppsScript } from '@/lib/cutting-bq';
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
import type { ApprovalEntity, CuttingSkuOption, CuttingPoOption, PoCategory, PoType, SdRole, SdStatus } from '../types';
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
 * Authenticated Cutting Register entry, matching the team template: the team picks a
 * fabric SKU, then a PO containing it, then the item on that PO, and fills the cutting
 * figures. Fields line up 1:1 with the warehouse table so the BigQuery push is direct.
 * The signed cutting-approval image is uploaded to storage client-side; its path is
 * passed here in `cutting_approval_sheet`.
 */
export async function saveCuttingRegister(formData: FormData): Promise<ActionResult> {
  const user = await currentUser();
  if (!user) return fail('Not signed in.');
  if (!canEdit(user.role, 'draft')) return fail('You do not have permission to add cutting entries.');

  const po_ref_num = String(formData.get('po_ref_num') ?? '').trim();
  if (!po_ref_num) return fail('Pick a PO.');
  const fabric_sku_code = textOrNull(formData.get('fabric_sku_code'));
  if (!fabric_sku_code) return fail('Pick the fabric SKU.');
  const item_code = textOrNull(formData.get('item_code'));
  const cutting_qty = numOrNull(formData.get('cutting_qty'));
  const fabric_consumed = numOrNull(formData.get('fabric_consumed'));
  if (cutting_qty == null && fabric_consumed == null) {
    return fail('Enter the cutting quantity or the fabric consumed.');
  }

  const product_code = productFromPoRef(po_ref_num);
  const supabase = await supa();

  const { data: inserted, error } = await supabase
    .from('sd_cutting_register')
    .insert({
      po_ref_num,
      po_number: textOrNull(formData.get('po_number')),
      product_code,
      vendor_code: textOrNull(formData.get('vendor_code')),
      fabric_sku_code,
      item_code,
      size: textOrNull(formData.get('size')),
      cutting_qty,
      avg_fabric_consumption_approved: numOrNull(formData.get('avg_fabric_consumption_approved')),
      width_of_fabric: textOrNull(formData.get('width_of_fabric')),
      cutting_approval_sheet: textOrNull(formData.get('cutting_approval_sheet')),
      fabric_consumed,
      cutting_date: dateOrNull(formData.get('cutting_date')),
      remarks: textOrNull(formData.get('remarks')),
      submitted_via: 'dashboard',
      submitted_by_email: user.email,
    })
    .select('id')
    .maybeSingle();
  if (error) return fail(`Could not save: ${error.message}`);

  // Push this entry to the warehouse (GCP BigQuery) immediately, best-effort — a GCP
  // failure never blocks the save; the twice-daily reconcile catches anything missed.
  // Preferred route is the Apps Script Web App (runs as the user, no service-account key);
  // if that isn't configured, fall back to a direct service-account push (needs GCP_SA_KEY).
  if (inserted?.id) {
    const id = Number(inserted.id);
    if (process.env.APPS_SCRIPT_CUTTING_URL) await pushCuttingViaAppsScript(id);
    else await pushCuttingRegisterRow(id);
  }

  revalidatePath('/cutting-register');
  return done(`Saved cutting entry for ${po_ref_num}.`);
}

/* ---- Cutting Register pickers: PO -> item (vendor + fabric SKU auto from the PO) ---- */

const PICK_LIMIT = 100;
// Cutting is done for production POs raised at the manufacturing entity; other warehouses
// (EBO, Amazon FBA, defective goods, etc.) are not relevant to the cutting register.
const CUTTING_WAREHOUSE = 'SAADAA SUSTAINABLE DESIGNS AND TECHNOLOGIES PRIVATE LIMITED';

/** Search POs at the SAADAA manufacturing location by PO reference / vendor (newest first). */
export async function searchPos(query: string): Promise<CuttingPoOption[]> {
  const user = await currentUser();
  if (!user) return [];
  const q = String(query ?? '').trim();
  const supabase = await supa();
  let sel = supabase
    .from('sd_po_master_raw')
    .select('po_ref_num, po_number, vendor_code, vendor_name, po_date')
    .eq('warehouse', CUTTING_WAREHOUSE)
    .order('po_date', { ascending: false, nullsFirst: false })
    .limit(1500);
  if (q) sel = sel.or(`po_ref_num.ilike.%${q}%,po_number.ilike.%${q}%,vendor_code.ilike.%${q}%,vendor_name.ilike.%${q}%`);
  const { data } = await sel;

  const byRef = new Map<string, CuttingPoOption>();
  for (const r of (data ?? []) as (CuttingPoOption & { po_date: string | null })[]) {
    const key = r.po_ref_num || r.po_number || '';
    if (!key || byRef.has(key)) continue;
    byRef.set(key, { po_ref_num: r.po_ref_num, po_number: r.po_number, vendor_code: r.vendor_code, vendor_name: r.vendor_name });
    if (byRef.size >= PICK_LIMIT) break;
  }
  return [...byRef.values()];
}

const SIZE_ORDER = ['XS', 'S', 'M', 'L', 'XL', '2XL', '3XL', '4XL', '5XL', 'XXL', 'XXXL'];
const sizeFromSku = (sku: string | null) => { const m = String(sku ?? '').match(/^.*_([^_]+)$/); return m ? m[1] : null; };

/** SKUs on a PO. Selecting one derives item code (product_code), dyed-fabric SKU and size. */
export async function loadPoSkus(poRefNum: string): Promise<CuttingSkuOption[]> {
  const user = await currentUser();
  if (!user) return [];
  const poRef = String(poRefNum ?? '').trim();
  if (!poRef) return [];
  const supabase = await supa();
  const { data } = await supabase
    .from('sd_po_master_raw')
    .select('product_variant, product_code, product_description, sku')
    .eq('po_ref_num', poRef)
    .eq('warehouse', CUTTING_WAREHOUSE)
    .limit(3000);
  const lines = (data ?? []) as { product_variant: string | null; product_code: string | null; product_description: string | null; sku: string | null }[];

  // Map each SKU to its dyed-fabric SKU from the Item Master.
  const skuList = [...new Set(lines.map((l) => l.sku).filter(Boolean) as string[])];
  const fabricBySku = new Map<string, string | null>();
  if (skuList.length) {
    const { data: pm } = await supabase
      .from('sd_ee_product_master')
      .select('sku, dyed_fabric_sku')
      .in('sku', skuList);
    for (const r of (pm ?? []) as { sku: string; dyed_fabric_sku: string | null }[]) fabricBySku.set(r.sku, r.dyed_fabric_sku);
  }

  const bySku = new Map<string, CuttingSkuOption>();
  for (const l of lines) {
    if (!l.sku || bySku.has(l.sku)) continue;
    bySku.set(l.sku, {
      sku: l.sku,
      item_code: l.product_code || l.product_variant || l.sku,
      fabric_sku_code: fabricBySku.get(l.sku) ?? null,
      size: sizeFromSku(l.sku),
      description: l.product_description,
    });
  }
  const rank = (s: string | null) => { const i = SIZE_ORDER.indexOf(String(s ?? '').toUpperCase()); return i === -1 ? 999 : i; };
  return [...bySku.values()].sort(
    (a, b) => a.item_code.localeCompare(b.item_code) || rank(a.size) - rank(b.size) || a.sku.localeCompare(b.sku),
  );
}

/** Bulk import cutting entries from a parsed template (Bulk Update mode). */
export async function bulkSaveCuttingRegister(formData: FormData): Promise<ActionResult> {
  const user = await currentUser();
  if (!user) return fail('Not signed in.');
  if (!canEdit(user.role, 'draft')) return fail('You do not have permission to add cutting entries.');
  let rows: Record<string, unknown>[] = [];
  try { rows = JSON.parse(String(formData.get('rows') ?? '[]')); } catch { rows = []; }
  if (!Array.isArray(rows) || !rows.length) return fail('No rows to import.');

  const clean = rows
    .map((r) => {
      const po = String(r.po_number ?? r.po_ref_num ?? '').trim();
      return {
        po_ref_num: po,
        po_number: po || null,
        product_code: po ? productFromPoRef(po) : null,
        vendor_code: textOrNull(r.vendor_code),
        fabric_sku_code: textOrNull(r.fabric_sku_code),
        item_code: textOrNull(r.item_code),
        size: textOrNull(r.size),
        cutting_qty: numOrNull(r.cutting_qty),
        avg_fabric_consumption_approved: numOrNull(r.avg_fabric_consumption_approved),
        width_of_fabric: textOrNull(r.width_of_fabric),
        cutting_approval_sheet: textOrNull(r.cutting_approval_sheet),
        fabric_consumed: numOrNull(r.fabric_consumed),
        cutting_date: dateOrNull(r.date_of_cutting),
        remarks: textOrNull(r.remarks_of_cutting),
        submitted_via: 'bulk',
        submitted_by_email: user.email,
      };
    })
    .filter((r) => r.po_ref_num);

  if (!clean.length) return fail('No valid rows — each row needs a PO number.');
  const supabase = await supa();
  const { error } = await supabase.from('sd_cutting_register').insert(clean);
  if (error) return fail(`Could not import: ${error.message}`);
  revalidatePath('/po-manual-adjustment');
  return done(`Imported ${clean.length} cutting ${clean.length === 1 ? 'entry' : 'entries'}. They sync to BigQuery within ~5 minutes.`);
}

/** Short-lived signed URL to view an uploaded cutting-approval image. */
export async function signCuttingApproval(path: string): Promise<{ url: string } | { error: string }> {
  const user = await currentUser();
  if (!user) return { error: 'Not signed in.' };
  const p = String(path ?? '').trim();
  if (!p) return { error: 'No file.' };
  if (!hasSupabaseAdminEnv()) return { error: 'Storage not configured.' };
  const admin = createAdminClient();
  const { data, error } = await admin.storage.from('cutting-approvals').createSignedUrl(p, 600);
  if (error || !data) return { error: error?.message ?? 'Could not sign URL.' };
  return { url: data.signedUrl };
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

  // The link path inserts via a SECURITY DEFINER RPC (no row id returned here), so push
  // to the warehouse with a best-effort reconcile — it picks up this row (and any other
  // not-yet-synced) and stamps them. Never blocks the vendor's submission. Preferred route
  // is the Apps Script Web App (no key); else the service-account reconcile.
  try {
    if (process.env.APPS_SCRIPT_CUTTING_URL) await pushCuttingViaAppsScript([]);
    else await reconcileCuttingToBq();
  } catch (err) {
    console.error('[cutting-bq] link-submit push failed (will retry in batch):', err instanceof Error ? err.message : err);
  }

  return done('Submitted — thank you!');
}

/* ================================================================== */
/* PO Closure — gating + two-leg workflow + surplus (spec §4-5)        */
/* ================================================================== */

/** Begin closure. Gated: only a completed PO (closure row carries the stamp). */
