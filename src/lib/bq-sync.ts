// Daily incremental BigQuery -> Supabase sync, shared by the /api/cron/sync-daily
// route. Append/upsert only — nothing is ever deleted (no mark-and-sweep). This
// is the cloud twin of backfill/sync-daily.mjs, but authenticates BigQuery with a
// service-account key (GCP_SA_KEY) instead of local ADC.
//
//   product master  EasyEcom_SAADAA_product_master -> sd_ee_product_master   (upsert on sku)
//   DOQ / planning   saadaa_inventory_planning      -> sd_inventory_planning   (latest snapshot, on sku|warehouse)
//   GRN              saadaa_po_grn_mapping           -> sd_po_grn_mapping       (last 45 days, on po_detail_id|grn_id)

import { BigQuery } from '@google-cloud/bigquery';

export type SyncTarget = 'product-master' | 'doq' | 'grn' | 'vendor-master';
export const GRN_WINDOW_DAYS = 45;

const flat = (v: unknown): unknown =>
  v && typeof v === 'object' && 'value' in (v as Record<string, unknown>)
    ? (v as { value: unknown }).value
    : v;

const PRODUCT_MASTER_COLS = new Set([
  'sku', 'mrp', 'c_id', 'cost', 'size', 'brand', 'cp_id', 'width', 'active', 'colour',
  'height', 'length', 'weight', 'brand_id', 'hsn_code', 'model_no', 'tax_rate', 'inventory',
  'created_at', 'product_id', 'updated_at', 'category_id', 'description', 'expiry_type',
  'company_name', 'cp_inventory', 'product_name', 'product_type', 'category_name',
  'accounting_sku', 'accounting_unit', 'product_image_url', 'product_shelf_life',
  'cp_sub_products_count',
]);
const INVENTORY_COLS = new Set([
  'date_day', 'sku', 'warehouse', 'rm_code', 'dyed_fabric_sku', 'product_name', 'product_variant',
  'color', 'size', 'category', 'sub_category', 'fabric_consumption_average', 'categorytype', 'cost',
  'item_category', 'gender', 'fittype', 'age_group', 'demographic_price_range', 'weave_type', 'fabric_name',
  'fabric_composition', 'fabric_gsm', 'garment_length_type', 'sleeve_type', 'neck_collar_type',
  'replenishment_type', 'washcare_sku', 'season', 'gst', 'related_ongoing_product', 'qty_in_metres',
  'product_state', 'daily_quantity', 'has_inventory_today', 't7_quantity', 't730_quantity', 't73015_quantity',
  't45_quantity', 'doq_7', 'doq_15', 'doq_7_30', 'doq_30_45', 'doq_90', 'doq_30', 'doq_45', 'doq_365',
  'oos_days_7', 'oos_days_15', 'oos_days_30', 'oos_days_45', 'oos_days_90', 'oos_days_365',
  'total_sales_in_last_45_inventory_days', 'weighted_doq_45', 'weightage_doq', 'monthly_doq', 'yearly_doq',
  'lead_time', 'buffer_days', 'current_stock', 'total_inprogress', 'shopify_sp', 'v_doq',
]);
const GRN_COLS = new Set([
  'po_created_date', 'po_detail_id', 'po_id', 'po_number', 'cp_id', 'sku', 'size', 'product_description',
  'po_created_warehouse', 'po_created_location_key', 'po_status', 'vendor_name', 'vendor_code',
  'expected_delivery_date', 'grn_id', 'po_ref_num', 'grn_status', 'grn_created_date', 'grn_invoice_date',
  'grn_invoice_number', 'last_grn_date', 'po_type', 'po_original_quantity', 'po_pending_quantity',
  'total_grn_value', 'grn_receive_quantity',
]);

type Row = Record<string, unknown>;

function pick(r: Row, allowed: Set<string>): Row {
  const out: Row = {};
  for (const [k, v] of Object.entries(r)) {
    const key = k.toLowerCase();
    if (allowed.has(key)) out[key] = flat(v);
  }
  return out;
}

function makeBq(): BigQuery {
  const raw = process.env.GCP_SA_KEY;
  if (!raw) throw new Error('GCP_SA_KEY is not set (service-account JSON for BigQuery).');
  const credentials = JSON.parse(raw);
  return new BigQuery({
    projectId: process.env.BQ_BILLING_PROJECT || credentials.project_id || 'saadaa-wh',
    location: 'asia-south1',
    credentials,
  });
}

function supaConfig() {
  const url = process.env.SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_SERVICE_ROLE;
  if (!url || !key) throw new Error('Supabase URL / service-role key not set.');
  return { url, key };
}

async function supa(method: string, path: string, body?: unknown): Promise<void> {
  const { url, key } = supaConfig();
  const res = await fetch(`${url}/rest/v1/${path}`, {
    method,
    headers: {
      apikey: key,
      Authorization: `Bearer ${key}`,
      'Content-Type': 'application/json',
      Prefer: 'resolution=merge-duplicates,return=minimal',
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  if (!res.ok) throw new Error(`Supabase ${method} ${path} -> ${res.status}: ${await res.text()}`);
}

async function supaGet<T = Row>(path: string): Promise<T[]> {
  const { url, key } = supaConfig();
  const res = await fetch(`${url}/rest/v1/${path}`, {
    headers: { apikey: key, Authorization: `Bearer ${key}` },
  });
  if (!res.ok) throw new Error(`Supabase GET ${path} -> ${res.status}: ${await res.text()}`);
  return res.json() as Promise<T[]>;
}

// Vendor master (code -> name) from GCP. Hybrid: GCP owns vendor_name; the Google
// Sheet still feeds the capacity model (type/merchant/machines/karigar). We only
// UPDATE names of vendors already in vendor_master_data — never insert — so the
// 5-min sheet sweep (deactivates rows lacking its sync_token) is left untouched.
async function syncVendorMaster(bq: BigQuery): Promise<number> {
  const [rows] = await bq.query({
    location: 'asia-south1',
    query:
      'SELECT DISTINCT vendor_code, vendor_name FROM `saadaa-wh.MAPLEMONK.Easyecom_Saadaa_vendors` ' +
      "WHERE vendor_code IS NOT NULL AND TRIM(vendor_name) != ''",
  });
  const gcp = new Map<string, string>();
  for (const r of rows as Row[]) {
    gcp.set(String(flat(r.vendor_code)), String(flat(r.vendor_name)).trim());
  }

  const existing = await supaGet<{ vendor_code: string }>('vendor_master_data?select=vendor_code');
  const codes = new Set(existing.map((r) => r.vendor_code));
  const updates = [...gcp.entries()]
    .filter(([code]) => codes.has(code))
    .map(([vendor_code, vendor_name]) => ({ vendor_code, vendor_name }));

  const BATCH = 500;
  for (let i = 0; i < updates.length; i += BATCH) {
    await supa('POST', 'vendor_master_data?on_conflict=vendor_code', updates.slice(i, i + BATCH));
  }
  return updates.length;
}

interface AppendSpec {
  table: string;
  conflict: string;
  query: string;
  allowed: Set<string>;
  keyOf: (r: Row) => string | null;
}

// Upsert on the conflict target; NEVER sweep. Returns rows written.
async function appendSync(bq: BigQuery, spec: AppendSpec): Promise<number> {
  const runStart = new Date().toISOString();
  const [rows] = await bq.query({ query: spec.query, location: 'asia-south1' });

  const mapped: Row[] = [];
  const seen = new Set<string>();
  for (const r of rows as Row[]) {
    const row = pick(r, spec.allowed);
    const k = spec.keyOf(row);
    if (!k || seen.has(k)) continue;
    seen.add(k);
    if (spec.conflict !== 'sku') row.row_key = k;
    row.synced_at = runStart;
    mapped.push(row);
  }

  const BATCH = 500;
  for (let i = 0; i < mapped.length; i += BATCH) {
    await supa('POST', `${spec.table}?on_conflict=${spec.conflict}`, mapped.slice(i, i + BATCH));
  }
  return mapped.length;
}

const SPECS: Record<Exclude<SyncTarget, 'vendor-master'>, AppendSpec> = {
  'product-master': {
    table: 'sd_ee_product_master',
    conflict: 'sku',
    allowed: PRODUCT_MASTER_COLS,
    keyOf: (r) => (r.sku as string) || null,
    query: 'SELECT * FROM `saadaa-wh.MAPLEMONK.EasyEcom_SAADAA_product_master`',
  },
  doq: {
    table: 'sd_inventory_planning',
    conflict: 'row_key',
    allowed: INVENTORY_COLS,
    keyOf: (r) => (r.sku ? `${r.sku}|${r.warehouse ?? ''}` : null),
    query:
      'SELECT * FROM `saadaa-wh.MAPLEMONK.saadaa_inventory_planning` ' +
      'WHERE date_day = (SELECT MAX(date_day) FROM `saadaa-wh.MAPLEMONK.saadaa_inventory_planning`)',
  },
  grn: {
    table: 'sd_po_grn_mapping',
    conflict: 'row_key',
    allowed: GRN_COLS,
    keyOf: (r) => (r.po_detail_id ? `${r.po_detail_id}|${r.grn_id ?? ''}` : null),
    query:
      'SELECT * FROM `saadaa-wh.MAPLEMONK.saadaa_po_grn_mapping` ' +
      `WHERE grn_created_date >= DATE_SUB(CURRENT_DATE('Asia/Kolkata'), INTERVAL ${GRN_WINDOW_DAYS} DAY)`,
  },
};

// Run one or all sync targets. Returns per-target rows written.
export async function runDailySync(only?: SyncTarget): Promise<Record<string, number>> {
  const bq = makeBq();
  const targets: SyncTarget[] = only ? [only] : ['product-master', 'doq', 'grn', 'vendor-master'];
  const summary: Record<string, number> = {};
  for (const t of targets) {
    summary[t] = t === 'vendor-master' ? await syncVendorMaster(bq) : await appendSync(bq, SPECS[t]);
  }
  return summary;
}
