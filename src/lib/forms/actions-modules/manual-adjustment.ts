'use server';

// Manual Adjustment (PO) — entered on the dashboard (Manual Data Ingestion → PO Manual
// Adjustment → UI Input) and pushed back to the warehouse BigQuery table
// po_qty_manual_adjustment. Append-only, like the cutting register: every save adds new
// adjustment rows (a correction is a compensating entry), never edits what already landed.

import { revalidatePath } from 'next/cache';
import { poTypeFromRef, pushManualAdjustmentRows, pushManualAdjustmentViaAppsScript } from '@/lib/manual-adjustment-bq';
import { currentUser } from '../queries';
import { canEdit } from '../approval';
import type { ManualAdjustmentEntry } from '../types';
import { type ActionResult, fail, done, supa, numOrNull, textOrNull } from './_shared';

type RowIn = { sku_code?: unknown; manual_adjust_qty?: unknown };

/**
 * Save one batch of adjustments for a PO: `po_ref_num` + `rows` (JSON array of
 * { sku_code, manual_adjust_qty }) + optional `remarks`. Rows with a blank quantity are
 * ignored; quantities must be whole numbers (signed). All rows insert together, then
 * push to BigQuery immediately (best-effort; the 5-minute Apps Script trigger / daily
 * sync reconcile anything missed).
 */
export async function saveManualAdjustments(formData: FormData): Promise<ActionResult> {
  const user = await currentUser();
  if (!user) return fail('Not signed in.');
  if (!canEdit(user.role, 'draft')) return fail('You do not have permission to enter adjustments.');

  const po_ref_num = String(formData.get('po_ref_num') ?? '').trim();
  if (!po_ref_num) return fail('Pick a PO.');
  const remarks = textOrNull(formData.get('remarks'));

  let rowsIn: RowIn[] = [];
  try { rowsIn = JSON.parse(String(formData.get('rows') ?? '[]')); } catch { rowsIn = []; }
  if (!Array.isArray(rowsIn)) rowsIn = [];

  const po_type = poTypeFromRef(po_ref_num);
  const clean: { po_ref_num: string; sku_code: string; manual_adjust_qty: number; po_type: string | null; remarks: string | null; submitted_via: string; submitted_by_email: string }[] = [];
  for (const r of rowsIn) {
    const sku = textOrNull(r.sku_code);
    const qtyRaw = r.manual_adjust_qty;
    if (!sku || qtyRaw === '' || qtyRaw == null) continue; // untouched row
    const qty = numOrNull(qtyRaw);
    if (qty == null || !Number.isInteger(qty)) return fail(`Adjust qty for ${sku} must be a whole number.`);
    if (qty === 0) continue; // a zero adjustment changes nothing
    clean.push({ po_ref_num, sku_code: sku, manual_adjust_qty: qty, po_type, remarks, submitted_via: 'dashboard', submitted_by_email: user.email });
  }
  if (!clean.length) return fail('Enter an adjust qty against at least one SKU.');

  const supabase = await supa();
  const { data: inserted, error } = await supabase
    .from('sd_manual_adjustment_entry')
    .insert(clean)
    .select('id');
  if (error) return fail(`Could not save: ${error.message}`);

  // Push to the warehouse (GCP BigQuery) right away, best-effort — a GCP failure never
  // blocks the save. Preferred route is the Apps Script web app (no service-account key);
  // when unconfigured, fall back to a direct service-account push (needs GCP_SA_KEY).
  const ids = ((inserted ?? []) as { id: number }[]).map((r) => Number(r.id)).filter((n) => n > 0);
  if (ids.length) {
    if (process.env.APPS_SCRIPT_ADJUST_URL) await pushManualAdjustmentViaAppsScript(ids);
    else await pushManualAdjustmentRows(ids);
  }

  revalidatePath('/po-manual-adjustment');
  const n = clean.length;
  return done(`Saved ${n} adjustment${n === 1 ? '' : 's'} for ${po_ref_num}. Syncing to BigQuery (≈5 min).`);
}

/** Most recent adjustments entered on the dashboard, newest first, with their BigQuery sync state. */
export async function loadRecentManualAdjustments(limit = 60): Promise<ManualAdjustmentEntry[]> {
  const user = await currentUser();
  if (!user) return [];
  const supabase = await supa();
  const { data } = await supabase
    .from('sd_manual_adjustment_entry')
    .select('id, po_ref_num, sku_code, manual_adjust_qty, po_type, remarks, submitted_by_email, created_at, bq_synced_at')
    .order('id', { ascending: false })
    .limit(limit);
  // PostgREST returns `numeric` as a string — normalise so the UI can sign/compare it.
  return ((data ?? []) as ManualAdjustmentEntry[]).map((r) => ({ ...r, manual_adjust_qty: Number(r.manual_adjust_qty) }));
}
