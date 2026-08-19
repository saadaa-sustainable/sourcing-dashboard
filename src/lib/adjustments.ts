// PO Manual Adjustment tab — data layer.
//
// Two adjustment feeds live in BigQuery and are mirrored into Supabase snapshot
// tables so the page renders instantly and stays viewable even if BigQuery is
// unreachable. The Refresh button does a live BigQuery re-pull, rate-limited to
// REFRESH_LIMIT_PER_HOUR per user per source (enforced via sd_adjustment_refresh_log).
//
//   'po'      -> po_qty_manual_adjustment -> sd_po_qty_manual_adjustment
//   'cutting' -> po_qty_cutting_register  -> sd_po_qty_cutting_register

import { BigQuery } from '@google-cloud/bigquery';
import { createClient, hasSupabaseEnv } from '@/lib/supabase/server';
import { createAdminClient, hasSupabaseAdminEnv } from '@/lib/supabase/admin';
import {
  LATEST_N,
  REFRESH_LIMIT_PER_HOUR,
  REFRESH_WINDOW_MS,
  type AdjustmentSource,
  type ManualAdjustmentRow,
  type CuttingRegisterRow,
  type RefreshState,
  type RefreshResult,
} from '@/lib/adjustments-types';

// Re-export so existing server-side importers can keep importing from '@/lib/adjustments'.
export type { AdjustmentSource, RefreshState, RefreshResult } from '@/lib/adjustments-types';
export { LATEST_N, REFRESH_LIMIT_PER_HOUR, REFRESH_WINDOW_MS } from '@/lib/adjustments-types';

const TABLES = {
  po: { bq: 'po_qty_manual_adjustment', supa: 'sd_po_qty_manual_adjustment', order: 'ingestion_date' },
  cutting: { bq: 'po_qty_cutting_register', supa: 'sd_po_qty_cutting_register', order: 'date_of_ingestion' },
} as const;

const flat = (v: unknown): unknown =>
  v && typeof v === 'object' && 'value' in (v as Record<string, unknown>)
    ? (v as { value: unknown }).value
    : v;

// Service-account key in the cloud (GCP_SA_KEY); local dev falls back to gcloud
// Application Default Credentials, so the tab works in `next dev` without the key.
function makeBq(): BigQuery {
  const opts = {
    projectId: process.env.BQ_BILLING_PROJECT || 'saadaa-wh',
    location: 'asia-south1',
  };
  const raw = process.env.GCP_SA_KEY;
  if (raw) return new BigQuery({ ...opts, credentials: JSON.parse(raw) });
  return new BigQuery(opts); // ADC fallback
}

async function queryManual(bq: BigQuery): Promise<ManualAdjustmentRow[]> {
  const [rows] = await bq.query({
    location: 'asia-south1',
    query:
      'SELECT po_no, sku_code, manual_adjust_qty, po_type, ' +
      'CAST(ingestion_date AS STRING) AS ingestion_date, ingestion_by ' +
      'FROM `saadaa-wh.MAPLEMONK.po_qty_manual_adjustment` ORDER BY ingestion_date DESC',
  });
  return (rows as Record<string, unknown>[]).map((r) => ({
    po_no: (flat(r.po_no) as string) ?? null,
    sku_code: (flat(r.sku_code) as string) ?? null,
    manual_adjust_qty: flat(r.manual_adjust_qty) == null ? null : Number(flat(r.manual_adjust_qty)),
    po_type: (flat(r.po_type) as string) ?? null,
    ingestion_date: (flat(r.ingestion_date) as string) ?? null,
    ingestion_by: (flat(r.ingestion_by) as string) ?? null,
  }));
}

async function queryCutting(bq: BigQuery): Promise<CuttingRegisterRow[]> {
  const [rows] = await bq.query({
    location: 'asia-south1',
    query:
      'SELECT CAST(date_of_cutting AS STRING) AS date_of_cutting, vendor_code, po_number, ' +
      'fabric_sku_code, item_code, cutting_qty, avg_fabric_consumption_approved, width_of_fabric, ' +
      'cutting_approval_sheet, remarks_of_cutting, fabric_consumed, type_of_po, ' +
      'CAST(date_of_ingestion AS STRING) AS date_of_ingestion, ingestion_by ' +
      'FROM `saadaa-wh.MAPLEMONK.po_qty_cutting_register` ' +
      'ORDER BY date_of_ingestion DESC, date_of_cutting DESC',
  });
  const num = (v: unknown) => (flat(v) == null ? null : Number(flat(v)));
  const str = (v: unknown) => (flat(v) as string) ?? null;
  return (rows as Record<string, unknown>[]).map((r) => ({
    date_of_cutting: str(r.date_of_cutting),
    vendor_code: str(r.vendor_code),
    po_number: str(r.po_number),
    fabric_sku_code: str(r.fabric_sku_code),
    item_code: str(r.item_code),
    cutting_qty: num(r.cutting_qty),
    avg_fabric_consumption_approved: num(r.avg_fabric_consumption_approved),
    width_of_fabric: str(r.width_of_fabric),
    cutting_approval_sheet: str(r.cutting_approval_sheet),
    remarks_of_cutting: str(r.remarks_of_cutting),
    fabric_consumed: num(r.fabric_consumed),
    type_of_po: str(r.type_of_po),
    date_of_ingestion: str(r.date_of_ingestion),
    ingestion_by: str(r.ingestion_by),
  }));
}

// Replace the whole snapshot: query BigQuery FIRST, then swap, so a BigQuery
// failure never wipes the existing cached rows.
async function replaceSnapshot(source: AdjustmentSource, rows: Record<string, unknown>[]): Promise<void> {
  const admin = createAdminClient();
  const table = TABLES[source].supa;
  const del = await admin.from(table).delete().gte('synced_at', '1970-01-01T00:00:00Z');
  if (del.error) throw new Error(`clear ${table}: ${del.error.message}`);
  if (rows.length) {
    const ins = await admin.from(table).insert(rows);
    if (ins.error) throw new Error(`insert ${table}: ${ins.error.message}`);
  }
}

/** Latest N cached rows for a source, read from Supabase (RLS select). */
export async function loadCached(source: AdjustmentSource) {
  if (!hasSupabaseEnv()) return [];
  const supabase = await createClient();
  const { data, error } = await supabase
    .from(TABLES[source].supa)
    .select('*')
    .order(TABLES[source].order, { ascending: false, nullsFirst: false })
    .limit(LATEST_N);
  if (error) throw new Error(`${TABLES[source].supa}: ${error.message}`);
  return data ?? [];
}

/** How many refreshes this user has left this hour for a source, per the audit log. */
export async function refreshState(userEmail: string, source: AdjustmentSource): Promise<RefreshState> {
  if (!hasSupabaseAdminEnv()) return { remaining: REFRESH_LIMIT_PER_HOUR, retryAfterMinutes: 0 };
  const admin = createAdminClient();
  const sinceIso = new Date(Date.now() - REFRESH_WINDOW_MS).toISOString();
  const { data } = await admin
    .from('sd_adjustment_refresh_log')
    .select('refreshed_at')
    .eq('source', source)
    .eq('user_email', userEmail)
    .gte('refreshed_at', sinceIso)
    .order('refreshed_at', { ascending: true });
  const used = data?.length ?? 0;
  const remaining = Math.max(0, REFRESH_LIMIT_PER_HOUR - used);
  let retryAfterMinutes = 0;
  if (remaining === 0 && data && data.length) {
    const oldest = new Date(data[0].refreshed_at as string).getTime();
    retryAfterMinutes = Math.max(1, Math.ceil((oldest + REFRESH_WINDOW_MS - Date.now()) / 60000));
  }
  return { remaining, retryAfterMinutes };
}

/**
 * Refresh = reload the latest cached rows, gated by the per-user/hour limit.
 *
 * Backfill method: BigQuery is pulled ONLY by the backfill loader (syncAllAdjustments,
 * run by sync-daily.mjs / the cron), which fills the Supabase snapshot tables. The web
 * runtime never queries BigQuery here, so Refresh works in prod without GCP creds — it
 * just re-reads whatever the last sync landed.
 */
export async function refreshSource(userEmail: string, source: AdjustmentSource): Promise<RefreshResult> {
  const state = await refreshState(userEmail, source);
  if (state.remaining <= 0) {
    const rows = await loadCached(source);
    return {
      ok: false,
      source,
      rows,
      remaining: 0,
      retryAfterMinutes: state.retryAfterMinutes,
      error: `Refresh limit reached (${REFRESH_LIMIT_PER_HOUR}/hour). Try again in ~${state.retryAfterMinutes} min.`,
    };
  }

  const rows = await loadCached(source);

  // Record the click (best-effort) so the per-hour cap is enforced across reloads.
  if (hasSupabaseAdminEnv()) {
    const admin = createAdminClient();
    await admin.from('sd_adjustment_refresh_log').insert({ user_email: userEmail, source });
  }

  return {
    ok: true,
    source,
    rows,
    remaining: state.remaining - 1,
    retryAfterMinutes: 0,
  };
}

/** Backend seed/refresh used by the daily sync — no rate limit, both sources. */
export async function syncAllAdjustments(): Promise<Record<AdjustmentSource, number>> {
  const bq = makeBq();
  const manual = (await queryManual(bq)) as unknown as Record<string, unknown>[];
  const cutting = (await queryCutting(bq)) as unknown as Record<string, unknown>[];
  await replaceSnapshot('po', manual);
  await replaceSnapshot('cutting', cutting);
  return { po: manual.length, cutting: cutting.length };
}
