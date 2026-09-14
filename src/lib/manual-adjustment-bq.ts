import 'server-only';
// Manual Adjustment (PO) → GCP (BigQuery). The team now enters PO manual adjustments on the
// Sourcing Dashboard (Supabase table sd_manual_adjustment_entry); this module pushes those
// rows BACK into the warehouse table saadaa-wh.MAPLEMONK.po_qty_manual_adjustment so the
// downstream warehouse consumers keep working. Twin of cutting-bq.ts (same pattern; the
// reverse of bq-sync.ts / adjustments.ts which pull BQ→Supabase).
//
// Two entry points, both best-effort (a GCP hiccup must never break a user's save):
//   • pushManualAdjustmentRows(ids)   — immediate, targeted push right after an on-dashboard save.
//   • reconcileManualAdjustmentToBq() — batch: pushes every row with bq_synced_at IS NULL. Runs
//                                        in the daily sync (target 'adjust-push') and via the
//                                        Apps Script time trigger, so any failed immediate push
//                                        is caught up.
//
// Idempotency: each row carries a deterministic insertId ("sd_manual_adjustment_entry:<id>")
// so a streaming retry dedups; a row is only pushed while bq_synced_at IS NULL, stamped on success.

import { BigQuery } from '@google-cloud/bigquery';
import { createAdminClient, hasSupabaseAdminEnv } from '@/lib/supabase/admin';

const BQ_DATASET = 'MAPLEMONK';
const BQ_TABLE = 'po_qty_manual_adjustment';
const SOURCE_TABLE = 'sd_manual_adjustment_entry';

// Columns we read from the source table to build a warehouse row.
const SELECT_COLS = 'id, po_ref_num, sku_code, manual_adjust_qty, po_type, submitted_by_email, created_at';

export type ManualAdjustmentSourceRow = {
  id: number;
  po_ref_num: string;
  sku_code: string;
  manual_adjust_qty: number;
  po_type: string | null;
  submitted_by_email: string | null;
  created_at: string;
};

// Service-account key in the cloud (GCP_SA_KEY); local dev falls back to gcloud ADC.
function makeBq(): BigQuery {
  const opts = {
    projectId: process.env.BQ_BILLING_PROJECT || 'saadaa-wh',
    location: 'asia-south1',
  };
  const raw = process.env.GCP_SA_KEY;
  if (raw) return new BigQuery({ ...opts, credentials: JSON.parse(raw) });
  return new BigQuery(opts); // ADC fallback
}

// po_ref_num is FY.../<TYPE>/<PRODUCT>/<VENDOR>-<SEQ>; the PO type is the 2nd segment.
export function poTypeFromRef(po: string): string | null {
  const t = (String(po ?? '').split('/')[1] ?? '').trim().toUpperCase();
  return t || null;
}

/**
 * Map one dashboard entry onto the warehouse table's schema. The warehouse feed keys the
 * PO by its reference (po_no), the SKU by variant code, and stamps who/when ingested;
 * ingestion_date uses the row's created_at so the value is stable across re-pushes.
 */
export function mapAdjustmentToWarehouse(r: ManualAdjustmentSourceRow): Record<string, unknown> {
  return {
    po_no: r.po_ref_num,
    sku_code: r.sku_code,
    manual_adjust_qty: r.manual_adjust_qty,
    po_type: r.po_type ?? poTypeFromRef(r.po_ref_num),
    ingestion_date: r.created_at,
    ingestion_by: r.submitted_by_email ?? 'sourcing-dashboard',
  };
}

// Cache the warehouse table's field types so date/timestamp/numeric values are coerced to
// whatever the column actually is (the types are not introspectable without BQ access at dev time).
let schemaCache: Map<string, string> | null = null;
async function getTypeMap(table: ReturnType<ReturnType<BigQuery['dataset']>['table']>): Promise<Map<string, string>> {
  if (schemaCache) return schemaCache;
  const [meta] = await table.getMetadata();
  const fields: { name: string; type: string }[] = meta?.schema?.fields ?? [];
  schemaCache = new Map(fields.map((f) => [f.name.toLowerCase(), String(f.type).toUpperCase()]));
  return schemaCache;
}

function coerce(value: unknown, type: string): unknown {
  if (value == null) return null;
  switch (type) {
    case 'DATE':
      return String(value).slice(0, 10);
    case 'TIMESTAMP':
      return new Date(value as string);
    case 'DATETIME':
      // BigQuery DATETIME wants 'YYYY-MM-DD HH:MM:SS' (no zone).
      return new Date(value as string).toISOString().replace('T', ' ').slice(0, 19);
    case 'INTEGER':
    case 'INT64':
    case 'FLOAT':
    case 'FLOAT64':
    case 'NUMERIC':
    case 'BIGNUMERIC':
      return Number(value);
    default:
      return typeof value === 'string' ? value : String(value);
  }
}

/**
 * Streaming-insert the given dashboard rows into the warehouse manual-adjustment table.
 * Throws on insert failure (callers wrap best-effort). Requires the service account to have
 * BigQuery Data Editor on the MAPLEMONK dataset. The payload is filtered to the columns that
 * exist in the live warehouse schema, so schema drift never breaks the push.
 */
export async function pushAdjustmentRowsToBq(rows: ManualAdjustmentSourceRow[]): Promise<number> {
  if (!rows.length) return 0;
  const table = makeBq().dataset(BQ_DATASET).table(BQ_TABLE);
  const typeMap = await getTypeMap(table);
  const payload = rows.map((r) => {
    const mapped = mapAdjustmentToWarehouse(r);
    const json: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(mapped)) {
      const t = typeMap.get(k.toLowerCase());
      if (!t) continue; // column not in the warehouse table — skip
      json[k] = coerce(v, t);
    }
    return { insertId: `${SOURCE_TABLE}:${r.id}`, json };
  });
  await table.insert(payload, { raw: true, skipInvalidRows: false, ignoreUnknownValues: false });
  return rows.length;
}

/**
 * Immediate, targeted push for freshly-saved rows, then stamp them synced. Best-effort:
 * returns false (never throws) so it can be awaited inline in a save action without ever
 * failing the save; unpushed rows are caught by reconcileManualAdjustmentToBq later.
 */
export async function pushManualAdjustmentRows(ids: number[]): Promise<boolean> {
  if (!ids.length || !hasSupabaseAdminEnv()) return false;
  try {
    const admin = createAdminClient();
    const { data } = await admin.from(SOURCE_TABLE).select(SELECT_COLS).in('id', ids).is('bq_synced_at', null);
    const rows = (data ?? []) as unknown as ManualAdjustmentSourceRow[];
    if (!rows.length) return false;
    await pushAdjustmentRowsToBq(rows);
    await admin.from(SOURCE_TABLE).update({ bq_synced_at: new Date().toISOString() }).in('id', rows.map((r) => r.id));
    return true;
  } catch (err) {
    console.error('[manual-adjustment-bq] immediate push failed (will retry in batch):', err instanceof Error ? err.message : err);
    return false;
  }
}

/**
 * Push via the Apps Script Web App (credential-free route: runs BigQuery as the installing
 * user, so no service-account key is needed in Vercel). POSTs the row ids + shared secret; an
 * empty list asks Apps Script to reconcile every unsynced row. Best-effort: returns false
 * (never throws) when unconfigured or on failure — the Apps Script time trigger reconciles
 * anything missed. Configure APPS_SCRIPT_ADJUST_URL + APPS_SCRIPT_ADJUST_SECRET in Vercel
 * (secret must match the script's ADJUST_PUSH_SECRET). NOTE: the saadaa.in Workspace blocks
 * anonymous web apps today, so in practice the 5-minute trigger is what runs.
 */
export async function pushManualAdjustmentViaAppsScript(ids: number[]): Promise<boolean> {
  const url = process.env.APPS_SCRIPT_ADJUST_URL;
  const secret = process.env.APPS_SCRIPT_ADJUST_SECRET;
  if (!url || !secret) return false;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 8000);
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ secret, ids }),
      signal: controller.signal,
    });
    if (!res.ok) return false;
    const data = (await res.json().catch(() => null)) as { ok?: boolean } | null;
    return data?.ok === true;
  } catch (err) {
    console.error('[manual-adjustment-bq] apps-script push failed (will retry in batch):', err instanceof Error ? err.message : err);
    return false;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Batch reconcile: push every row not yet in BigQuery and stamp them. Idempotent and safe to
 * run repeatedly. Returns the number of rows pushed. Throws only on an unexpected DB read
 * error; the daily sync wraps this best-effort so a BQ permission issue cannot break the reads.
 */
export async function reconcileManualAdjustmentToBq(limit = 5000): Promise<number> {
  if (!hasSupabaseAdminEnv()) return 0;
  const admin = createAdminClient();
  const { data, error } = await admin
    .from(SOURCE_TABLE)
    .select(SELECT_COLS)
    .is('bq_synced_at', null)
    .order('id', { ascending: true })
    .limit(limit);
  if (error) throw new Error(`${SOURCE_TABLE} read: ${error.message}`);
  const rows = (data ?? []) as unknown as ManualAdjustmentSourceRow[];
  if (!rows.length) return 0;

  await pushAdjustmentRowsToBq(rows);
  const { error: upErr } = await admin
    .from(SOURCE_TABLE)
    .update({ bq_synced_at: new Date().toISOString() })
    .in('id', rows.map((r) => r.id));
  if (upErr) throw new Error(`stamp bq_synced_at: ${upErr.message}`);
  return rows.length;
}
