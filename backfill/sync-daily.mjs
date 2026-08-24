// =====================================================================
// DAILY incremental sync (append/upsert only — nothing is deleted).
// Meant for the 6 AM cron. Pulls only what changed since the last run and
// merges it in; historical rows are left untouched.
//
//   1. Product master  saadaa-wh.MAPLEMONK.Easyecom_new_product_master (+ _custom_fields)
//                       -> sd_ee_product_master        (upsert on sku; see product-master-query.mjs)
//   2. DOQ / planning   saadaa-wh.MAPLEMONK.saadaa_inventory_planning
//                       -> sd_inventory_planning        (latest snapshot, upsert on sku|warehouse)
//   3. GRN              saadaa-wh.MAPLEMONK.saadaa_po_grn_mapping
//                       -> sd_po_grn_mapping            (last 45 days, upsert on po_detail_id|grn_id)
//   4. Vendor master    saadaa-wh.MAPLEMONK.Easyecom_Saadaa_vendors
//                       -> vendor_master_data           (code->name only, updates existing rows)
//   5. OOS calculation  saadaa-wh.MAPLEMONK.saadaa_inventory_planning
//                       -> sd_oos_calculation           (1 row/SKU, 45d metrics + DOH, upsert on sku)
//
// Runs as YOU via Application Default Credentials; the query bills to saadaa-wh.
// Unlike sync-extra.mjs / sync-product-master.mjs (full refresh + mark-and-sweep),
// this NEVER sweeps — it only appends new rows and updates changed ones. Vendor
// master is HYBRID: GCP owns vendor_name; the Google Sheet still feeds the capacity
// model (type/merchant/machines/karigar), so we only update names of existing vendors.
//
// Usage:
//   node sync-daily.mjs                # product master + DOQ + GRN (45d) + vendor master + OOS
//   node sync-daily.mjs --test         # small pull per source, prints samples, still writes
//   node sync-daily.mjs oos            # just one:  product-master | doq | grn | vendor-master | oos
// =====================================================================

import { readFileSync } from 'node:fs';
import { BigQuery } from '@google-cloud/bigquery';
import { PM_QUERY, PM_COLS } from './product-master-query.mjs';

try {
  const env = readFileSync(new URL('./.env', import.meta.url), 'utf8');
  for (const line of env.split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
    if (m && process.env[m[1]] === undefined) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
  }
} catch {
  /* rely on real env vars */
}

const TEST = process.argv.includes('--test');
const ONLY = process.argv.find((a) => ['product-master', 'doq', 'grn', 'vendor-master', 'oos', 'adjustments'].includes(a));
const GRN_WINDOW_DAYS = 45;

const { SUPABASE_URL, SUPABASE_SERVICE_ROLE, BQ_BILLING_PROJECT = 'saadaa-wh' } = process.env;
if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE) {
  console.error('Set SUPABASE_URL + SUPABASE_SERVICE_ROLE in backfill/.env.');
  process.exit(1);
}
console.log(`Target: ${SUPABASE_URL}  (${new Date().toISOString()})`);

const bq = new BigQuery({ projectId: BQ_BILLING_PROJECT, location: 'asia-south1' });
const flat = (v) => (v && typeof v === 'object' && 'value' in v ? v.value : v);

const INVENTORY_COLS = new Set([
  'date_day','sku','warehouse','rm_code','dyed_fabric_sku','product_name','product_variant',
  'color','size','category','sub_category','fabric_consumption_average','categorytype','cost',
  'item_category','gender','fittype','age_group','demographic_price_range','weave_type','fabric_name',
  'fabric_composition','fabric_gsm','garment_length_type','sleeve_type','neck_collar_type',
  'replenishment_type','washcare_sku','season','gst','related_ongoing_product','qty_in_metres',
  'product_state','daily_quantity','has_inventory_today','t7_quantity','t730_quantity','t73015_quantity',
  't45_quantity','doq_7','doq_15','doq_7_30','doq_30_45','doq_90','doq_30','doq_45','doq_365',
  'oos_days_7','oos_days_15','oos_days_30','oos_days_45','oos_days_90','oos_days_365',
  'total_sales_in_last_45_inventory_days','weighted_doq_45','weightage_doq','monthly_doq','yearly_doq',
  'lead_time','buffer_days','current_stock','total_inprogress','shopify_sp','v_doq',
]);
const GRN_COLS = new Set([
  'po_created_date','po_detail_id','po_id','po_number','cp_id','sku','size','product_description',
  'po_created_warehouse','po_created_location_key','po_status','vendor_name','vendor_code',
  'expected_delivery_date','grn_id','po_ref_num','grn_status','grn_created_date','grn_invoice_date',
  'grn_invoice_number','last_grn_date','po_type','po_original_quantity','po_pending_quantity',
  'total_grn_value','grn_receive_quantity',
]);

// OOS Calculation output columns (already the final sd_oos_calculation shape — the
// query aggregates + derives them, so appendSync just passes them through on sku).
const OOS_COLS = new Set([
  'sku','product_status','category_with_gender','rm_code','dyed_fabric_sku','product_variant',
  'product_name','color','size','weave_type','total_oos_days','total_qty_sold','doq_45',
  'current_stock','inprocess_stock','doh','doh_with_inprocess',
]);

// One row per garment SKU from the latest inventory-planning snapshot (warehouses
// combined, raw-fabric metre SKUs excluded), 45-day metrics + derived DOH. Mirrors
// backfill/backfill-oos.mjs; the pending columns (sales/class/etc.) are left untouched.
const OOS_QUERY = `
WITH latest AS (
  SELECT * FROM \`saadaa-wh.MAPLEMONK.saadaa_inventory_planning\`
  WHERE date_day = (SELECT MAX(date_day) FROM \`saadaa-wh.MAPLEMONK.saadaa_inventory_planning\`)
    AND UPPER(COALESCE(Size, '')) <> 'IN METERS'
    AND NOT REGEXP_CONTAINS(sku, r'^[^/]+/[^/]+/[^/]+$')  -- dyed-fabric/RM codes with NULL Size
),
agg AS (
  SELECT
    sku,
    ANY_VALUE(product_state) AS product_status,
    TRIM(CONCAT(COALESCE(ANY_VALUE(Category),''),' ',COALESCE(ANY_VALUE(Gender),''))) AS category_with_gender,
    ANY_VALUE(RM_code) AS rm_code,
    ANY_VALUE(Dyed_Fabric_SKU) AS dyed_fabric_sku,
    ANY_VALUE(Product_Variant) AS product_variant,
    ANY_VALUE(product_name) AS product_name,
    ANY_VALUE(Color) AS color,
    ANY_VALUE(Size) AS size,
    ANY_VALUE(WEAVE_TYPE) AS weave_type,
    MAX(oos_days_45) AS total_oos_days,
    MAX(total_sales_in_last_45_inventory_days) AS total_qty_sold,
    MAX(doq_45) AS doq_45,
    SUM(current_stock) AS current_stock,
    SUM(total_inprogress) AS inprocess_stock
  FROM latest GROUP BY sku
)
SELECT sku, product_status, category_with_gender, rm_code, dyed_fabric_sku, product_variant,
  product_name, color, size, weave_type, total_oos_days, total_qty_sold, doq_45,
  current_stock, inprocess_stock,
  ROUND(SAFE_DIVIDE(current_stock, NULLIF(doq_45, 0)), 1) AS doh,
  ROUND(SAFE_DIVIDE(current_stock + inprocess_stock, NULLIF(doq_45, 0)), 1) AS doh_with_inprocess
FROM agg
WHERE sku IS NOT NULL AND sku <> ''`;

function pick(r, allowed) {
  const out = {};
  for (const [k, v] of Object.entries(r)) {
    const key = k.toLowerCase();
    if (allowed.has(key)) out[key] = flat(v);
  }
  return out;
}

async function supa(method, path, body) {
  const res = await fetch(`${SUPABASE_URL}/rest/v1/${path}`, {
    method,
    headers: {
      apikey: SUPABASE_SERVICE_ROLE,
      Authorization: `Bearer ${SUPABASE_SERVICE_ROLE}`,
      'Content-Type': 'application/json',
      Prefer: 'resolution=merge-duplicates,return=minimal',
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  if (!res.ok) throw new Error(`Supabase ${method} ${path} → ${res.status}: ${await res.text()}`);
}

async function supaGet(path) {
  const res = await fetch(`${SUPABASE_URL}/rest/v1/${path}`, {
    headers: { apikey: SUPABASE_SERVICE_ROLE, Authorization: `Bearer ${SUPABASE_SERVICE_ROLE}` },
  });
  if (!res.ok) throw new Error(`Supabase GET ${path} → ${res.status}: ${await res.text()}`);
  return res.json();
}

// Vendor master (code -> name) from GCP. Hybrid: GCP owns vendor_name; the Google
// Sheet still feeds the capacity model (type/merchant/machines/karigar). We only
// UPDATE names of vendors already in vendor_master_data — never insert new rows —
// so the 5-min sheet sweep (which deactivates rows lacking its sync_token) is left
// alone. The partial {vendor_code, vendor_name} upsert touches only vendor_name.
async function syncVendorMaster() {
  console.log('\n[vendor_master] querying BigQuery…');
  const [rows] = await bq.query({
    location: 'asia-south1',
    query: `SELECT DISTINCT vendor_code, vendor_name
            FROM \`saadaa-wh.MAPLEMONK.Easyecom_Saadaa_vendors\`
            WHERE vendor_code IS NOT NULL AND TRIM(vendor_name) != ''`,
  });
  const gcp = new Map();
  for (const r of rows) gcp.set(flat(r.vendor_code), String(flat(r.vendor_name)).trim());

  const existing = await supaGet('vendor_master_data?select=vendor_code');
  const codes = new Set(existing.map((r) => r.vendor_code));
  const updates = [...gcp.entries()]
    .filter(([code]) => codes.has(code))
    .map(([vendor_code, vendor_name]) => ({ vendor_code, vendor_name }));

  console.log(`[vendor_master] ${updates.length} existing vendors matched in GCP (of ${codes.size}); updating names.`);
  if (TEST) console.log(JSON.stringify(updates.slice(0, 3), null, 2));

  const BATCH = 500;
  for (let i = 0; i < updates.length; i += BATCH) {
    await supa('POST', 'vendor_master_data?on_conflict=vendor_code', updates.slice(i, i + BATCH));
  }
  console.log(`[vendor_master] done (updated ${updates.length} names, capacity fields untouched).`);
}

// PO Manual Adjustment feeds — small snapshot tables (no natural key), so each run
// REPLACES all rows (delete + insert). Backs the PO Manual Adjustment tab; the tab's
// Refresh button does the same replace live, rate-limited per user.
async function syncAdjustments() {
  console.log('\n[adjustments] querying BigQuery…');
  const [manual] = await bq.query({
    location: 'asia-south1',
    query: `SELECT po_no, sku_code, manual_adjust_qty, po_type,
                   CAST(ingestion_date AS STRING) AS ingestion_date, ingestion_by
            FROM \`saadaa-wh.MAPLEMONK.po_qty_manual_adjustment\` ORDER BY ingestion_date DESC`,
  });
  const [cutting] = await bq.query({
    location: 'asia-south1',
    query: `SELECT CAST(date_of_cutting AS STRING) AS date_of_cutting, vendor_code, po_number,
                   fabric_sku_code, item_code, cutting_qty, avg_fabric_consumption_approved,
                   width_of_fabric, cutting_approval_sheet, remarks_of_cutting, fabric_consumed,
                   type_of_po, CAST(date_of_ingestion AS STRING) AS date_of_ingestion, ingestion_by
            FROM \`saadaa-wh.MAPLEMONK.po_qty_cutting_register\` ORDER BY date_of_ingestion DESC`,
  });
  const mrows = manual.map((r) => pick(r, new Set(['po_no', 'sku_code', 'manual_adjust_qty', 'po_type', 'ingestion_date', 'ingestion_by'])));
  const crows = cutting.map((r) => pick(r, new Set(['date_of_cutting', 'vendor_code', 'po_number', 'fabric_sku_code', 'item_code', 'cutting_qty', 'avg_fabric_consumption_approved', 'width_of_fabric', 'cutting_approval_sheet', 'remarks_of_cutting', 'fabric_consumed', 'type_of_po', 'date_of_ingestion', 'ingestion_by'])));

  await supa('DELETE', 'sd_po_qty_manual_adjustment?synced_at=gte.1970-01-01T00:00:00Z');
  for (let i = 0; i < mrows.length; i += 500) await supa('POST', 'sd_po_qty_manual_adjustment', mrows.slice(i, i + 500));
  await supa('DELETE', 'sd_po_qty_cutting_register?synced_at=gte.1970-01-01T00:00:00Z');
  for (let i = 0; i < crows.length; i += 500) await supa('POST', 'sd_po_qty_cutting_register', crows.slice(i, i + 500));
  console.log(`[adjustments] replaced: manual ${mrows.length} rows, cutting ${crows.length} rows.`);
}

// Append-only: upsert on the conflict target, NO mark-and-sweep delete.
async function appendSync({ label, table, conflict, query, allowed, keyOf }) {
  const runStart = new Date().toISOString();
  console.log(`\n[${label}] querying BigQuery…`);
  const [rows] = await bq.query({ query, location: 'asia-south1' });

  const mapped = [];
  const seen = new Set();
  for (const r of rows) {
    const row = pick(r, allowed);
    const k = keyOf(row);
    if (!k || seen.has(k)) continue;
    seen.add(k);
    if (conflict !== 'sku') row.row_key = k; // sd_* landing tables key on row_key; product master keys on sku
    row.synced_at = runStart;
    mapped.push(row);
  }
  console.log(`[${label}] ${mapped.length} rows to upsert (append mode, no sweep).`);
  if (TEST) console.log(JSON.stringify(mapped.slice(0, 2), null, 2));

  const BATCH = 500;
  let done = 0;
  for (let i = 0; i < mapped.length; i += BATCH) {
    await supa('POST', `${table}?on_conflict=${conflict}`, mapped.slice(i, i + BATCH));
    done += Math.min(BATCH, mapped.length - i);
    process.stdout.write(`\r[${label}] upserted ${done}/${mapped.length}`);
  }
  console.log(`\n[${label}] done (appended/updated ${mapped.length}).`);
}

async function main() {
  if (!ONLY || ONLY === 'product-master') {
    await appendSync({
      label: 'product_master',
      table: 'sd_ee_product_master',
      conflict: 'sku',
      allowed: PM_COLS,
      keyOf: (r) => r.sku || null,
      query: PM_QUERY + (TEST ? '\nLIMIT 20' : ''),
    });
  }

  if (!ONLY || ONLY === 'doq') {
    await appendSync({
      label: 'inventory_planning',
      table: 'sd_inventory_planning',
      conflict: 'row_key',
      allowed: INVENTORY_COLS,
      keyOf: (r) => (r.sku ? `${r.sku}|${r.warehouse ?? ''}` : null),
      query: `SELECT * FROM \`saadaa-wh.MAPLEMONK.saadaa_inventory_planning\`
              WHERE date_day = (SELECT MAX(date_day) FROM \`saadaa-wh.MAPLEMONK.saadaa_inventory_planning\`)
              ${TEST ? 'LIMIT 20' : ''}`,
    });
  }

  if (!ONLY || ONLY === 'grn') {
    await appendSync({
      label: 'po_grn_mapping',
      table: 'sd_po_grn_mapping',
      conflict: 'row_key',
      allowed: GRN_COLS,
      keyOf: (r) => (r.po_detail_id ? `${r.po_detail_id}|${r.grn_id ?? ''}` : null),
      query: `SELECT * FROM \`saadaa-wh.MAPLEMONK.saadaa_po_grn_mapping\`
              WHERE grn_created_date >= DATE_SUB(CURRENT_DATE('Asia/Kolkata'), INTERVAL ${GRN_WINDOW_DAYS} DAY)
              ${TEST ? 'LIMIT 20' : ''}`,
    });
  }

  if (!ONLY || ONLY === 'oos') {
    // OOS Calculation — runs after DOQ so it reflects the same snapshot day.
    await appendSync({
      label: 'oos_calculation',
      table: 'sd_oos_calculation',
      conflict: 'sku',
      allowed: OOS_COLS,
      keyOf: (r) => r.sku || null,
      query: OOS_QUERY + (TEST ? '\nLIMIT 20' : ''),
    });
  }

  if (!ONLY || ONLY === 'vendor-master') {
    await syncVendorMaster();
  }

  if (!ONLY || ONLY === 'adjustments') {
    await syncAdjustments();
  }

  console.log('\nDaily sync complete.');
}

main().catch((err) => {
  console.error('\nsync-daily failed:', err.message || err);
  process.exit(1);
});
