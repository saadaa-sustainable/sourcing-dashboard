import 'server-only';
// Cutting register → GCP (BigQuery). The team now enters cutting-register data on the
// Sourcing Dashboard (Supabase table sd_cutting_register); this module pushes those rows
// BACK into the warehouse table saadaa-wh.MAPLEMONK.po_qty_cutting_register so downstream
// warehouse consumers keep working. This is the reverse of bq-sync.ts (which pulls BQ→Supabase).
//
// Two entry points, both best-effort (a GCP hiccup must never break a user's save):
//   • pushCuttingRegisterRow(id) — immediate, targeted push right after an on-dashboard save.
//   • reconcileCuttingToBq()     — batch: pushes every row with bq_synced_at IS NULL. Runs in
//                                   the twice-daily sync and after a /fill-link submit, so the
//                                   anon link path and any failed immediate push are caught up.
//
// Idempotency: each row carries a deterministic insertId ("sd_cutting_register:<id>") so a
// streaming retry dedups; and a row is only pushed while bq_synced_at IS NULL, stamped on success.

import { BigQuery } from '@google-cloud/bigquery';
import { createAdminClient, hasSupabaseAdminEnv } from '@/lib/supabase/admin';

const BQ_DATASET = 'MAPLEMONK';
const BQ_TABLE = 'po_qty_cutting_register';

// Columns we read from sd_cutting_register to build a warehouse row.
const SELECT_COLS =
  'id, po_ref_num, po_number, product_code, vendor_code, fabric_sku_code, item_code, size, ' +
  'cutting_qty, avg_fabric_consumption_approved, width_of_fabric, cutting_approval_sheet, ' +
  'fabric_consumed, bom_standard_qty, actual_consumption_qty, cutting_date, remarks, ' +
  'submitted_by_email, submitted_by_name, created_at';

export type CuttingSourceRow = {
  id: number;
  po_ref_num: string;
  po_number: string | null;
  product_code: string | null;
  vendor_code: string | null;
  fabric_sku_code: string | null;
  item_code: string | null;
  size: string | null;
  cutting_qty: number | null;
  avg_fabric_consumption_approved: number | null;
  width_of_fabric: string | null;
  cutting_approval_sheet: string | null;
  fabric_consumed: number | null;
  bom_standard_qty: number | null;
  actual_consumption_qty: number | null;
  cutting_date: string | null;
  remarks: string | null;
  submitted_by_email: string | null;
  submitted_by_name: string | null;
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

// po_ref_num is FY.../<TYPE>/<PRODUCT>/<VENDOR>-<SEQ> (see productFromPoRef). Derive the
// PO type and vendor code from it; null when the ref doesn't follow the shape.
function parsePoRef(po: string): { type: string | null; vendor: string | null } {
  const parts = po.split('/');
  const type = parts[1]?.trim() || null;
  const vendorSeq = parts[3]?.trim() || '';
  const vendor = vendorSeq ? vendorSeq.split('-')[0]?.trim() || null : null;
  return { type, vendor };
}

/**
 * Map one dashboard cutting-register row onto the warehouse table's schema. Fields the
 * dashboard form doesn't capture (cutting_qty, fabric_sku_code, width_of_fabric,
 * cutting_approval_sheet) are left null. date_of_ingestion uses the row's created_at so
 * the value is stable across re-pushes.
 */
export function mapCuttingToWarehouse(r: CuttingSourceRow): Record<string, unknown> {
  const { type, vendor } = parsePoRef(r.po_ref_num);
  // Prefer the fields the team actually captured (template flow); fall back to the derived
  // / legacy values for rows created before the redesign or via the public /fill link.
  return {
    date_of_cutting: r.cutting_date,
    vendor_code: r.vendor_code ?? vendor,
    po_number: r.po_number ?? r.po_ref_num,
    fabric_sku_code: r.fabric_sku_code,
    item_code: r.item_code ?? r.product_code,
    size: r.size,
    cutting_qty: r.cutting_qty,
    avg_fabric_consumption_approved: r.avg_fabric_consumption_approved ?? r.bom_standard_qty,
    width_of_fabric: r.width_of_fabric,
    cutting_approval_sheet: r.cutting_approval_sheet,
    remarks_of_cutting: r.remarks,
    fabric_consumed: r.fabric_consumed ?? r.actual_consumption_qty,
    type_of_po: type,
    date_of_ingestion: r.created_at,
    ingestion_by: r.submitted_by_email ?? r.submitted_by_name ?? 'sourcing-dashboard',
  };
}

// Cache the warehouse table's field types so date/timestamp/numeric values are coerced to
// whatever the column actually is — we can't hardcode the types without BQ access at dev time.
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
      return String(value).slice(0, 10); // 'YYYY-MM-DD'
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
 * Streaming-insert the given dashboard rows into the warehouse cutting register. Throws on
 * insert failure (callers wrap best-effort). Requires the service account to have BigQuery
 * Data Editor on the MAPLEMONK dataset.
 */
export async function pushCuttingRowsToBq(rows: CuttingSourceRow[]): Promise<number> {
  if (!rows.length) return 0;
  const table = makeBq().dataset(BQ_DATASET).table(BQ_TABLE);
  const typeMap = await getTypeMap(table);
  const payload = rows.map((r) => {
    const mapped = mapCuttingToWarehouse(r);
    const json: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(mapped)) {
      const t = typeMap.get(k.toLowerCase());
      if (!t) continue; // column not in the warehouse table (e.g. `size` until it's added) — skip
      json[k] = coerce(v, t);
    }
    return { insertId: `sd_cutting_register:${r.id}`, json };
  });
  await table.insert(payload, { raw: true, skipInvalidRows: false, ignoreUnknownValues: false });
  return rows.length;
}

/**
 * Immediate, targeted push for a single freshly-saved row, then stamp it synced.
 * Best-effort: returns false (never throws) so it can be awaited inline in a save action
 * without ever failing the save; unpushed rows are caught by reconcileCuttingToBq later.
 */
export async function pushCuttingRegisterRow(id: number): Promise<boolean> {
  if (!hasSupabaseAdminEnv()) return false;
  try {
    const admin = createAdminClient();
    const { data } = await admin.from('sd_cutting_register').select(SELECT_COLS).eq('id', id).maybeSingle();
    if (!data) return false;
    await pushCuttingRowsToBq([data as unknown as CuttingSourceRow]);
    await admin.from('sd_cutting_register').update({ bq_synced_at: new Date().toISOString() }).eq('id', id);
    return true;
  } catch (err) {
    console.error('[cutting-bq] immediate push failed (will retry in batch):', err instanceof Error ? err.message : err);
    return false;
  }
}

/**
 * Push via the Apps Script Web App (the credential-free route: it runs BigQuery as the
 * installing user, so no service account / GCP_SA_KEY is needed in Vercel). POSTs the row
 * id(s) + shared secret; an empty list asks Apps Script to reconcile every unsynced row.
 * Best-effort: returns false (never throws) when unconfigured or on failure — the Apps
 * Script time trigger reconciles anything missed. Configure APPS_SCRIPT_CUTTING_URL +
 * APPS_SCRIPT_CUTTING_SECRET in Vercel (secret must match the script's CUTTING_PUSH_SECRET).
 */
export async function pushCuttingViaAppsScript(idOrIds: number | number[]): Promise<boolean> {
  const url = process.env.APPS_SCRIPT_CUTTING_URL;
  const secret = process.env.APPS_SCRIPT_CUTTING_SECRET;
  if (!url || !secret) return false;
  const ids = Array.isArray(idOrIds) ? idOrIds : [idOrIds];
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
    console.error('[cutting-bq] apps-script push failed (will retry in batch):', err instanceof Error ? err.message : err);
    return false;
  } finally {
    clearTimeout(timer);
  }
}

export type CuttingBqProbe = {
  keyPresent: boolean; // is GCP_SA_KEY set in this runtime?
  projectId: string;
  dataset: string;
  table: string;
  canReadTable: boolean; // dataset/table metadata reachable
  canWrite: boolean; // write permission confirmed (non-destructive dry-run INSERT)
  verdict: 'ready' | 'no-key' | 'read-only' | 'no-access';
  error?: string;
};

/**
 * Non-destructive check of whether THIS runtime's service account can actually write to the
 * warehouse cutting-register table — so write access can be verified before relying on the
 * push. Reads table metadata (connectivity + read), then dry-runs an INSERT that executes
 * nothing (DML planning still requires write permission, so a missing role surfaces here).
 * Writes no rows. Admin-gated by its route.
 */
export async function probeCuttingBqAccess(): Promise<CuttingBqProbe> {
  const projectId = process.env.BQ_BILLING_PROJECT || 'saadaa-wh';
  const out: CuttingBqProbe = {
    keyPresent: !!process.env.GCP_SA_KEY,
    projectId,
    dataset: BQ_DATASET,
    table: BQ_TABLE,
    canReadTable: false,
    canWrite: false,
    verdict: 'no-access',
  };
  try {
    const bq = makeBq();
    const table = bq.dataset(BQ_DATASET).table(BQ_TABLE);
    await table.getMetadata();
    out.canReadTable = true;
    // Dry-run only (nothing is inserted); DML planning checks tables.updateData.
    await bq.createQueryJob({
      query: `INSERT INTO \`${projectId}.${BQ_DATASET}.${BQ_TABLE}\` (po_number) SELECT CAST(NULL AS STRING) WHERE 1 = 0`,
      location: 'asia-south1',
      dryRun: true,
    });
    out.canWrite = true;
  } catch (err) {
    out.error = err instanceof Error ? err.message : String(err);
  }
  out.verdict = !out.keyPresent
    ? 'no-key'
    : out.canWrite
      ? 'ready'
      : out.canReadTable
        ? 'read-only'
        : 'no-access';
  return out;
}

/**
 * Batch reconcile: push every row not yet in BigQuery and stamp them. Idempotent and safe to
 * run repeatedly. Returns the number of rows pushed. Throws only on an unexpected DB read
 * error; the daily sync wraps this best-effort so a BQ permission issue can't break the reads.
 */
export async function reconcileCuttingToBq(limit = 5000): Promise<number> {
  if (!hasSupabaseAdminEnv()) return 0;
  const admin = createAdminClient();
  const { data, error } = await admin
    .from('sd_cutting_register')
    .select(SELECT_COLS)
    .is('bq_synced_at', null)
    .order('id', { ascending: true })
    .limit(limit);
  if (error) throw new Error(`sd_cutting_register read: ${error.message}`);
  const rows = (data ?? []) as unknown as CuttingSourceRow[];
  if (!rows.length) return 0;

  await pushCuttingRowsToBq(rows);
  const nowIso = new Date().toISOString();
  const ids = rows.map((r) => r.id);
  const { error: upErr } = await admin
    .from('sd_cutting_register')
    .update({ bq_synced_at: nowIso })
    .in('id', ids);
  if (upErr) throw new Error(`stamp bq_synced_at: ${upErr.message}`);
  return rows.length;
}
