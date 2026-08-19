// =====================================================================
// DAILY incremental sync (append/upsert only — nothing is deleted).
// Meant for the 6 AM cron. Pulls only what changed since the last run and
// merges it in; historical rows are left untouched.
//
//   1. Product master  saadaa-wh.MAPLEMONK.EasyEcom_SAADAA_product_master
//                       -> sd_ee_product_master        (upsert on sku)
//   2. DOQ / planning   saadaa-wh.MAPLEMONK.saadaa_inventory_planning
//                       -> sd_inventory_planning        (latest snapshot, upsert on sku|warehouse)
//   3. GRN              saadaa-wh.MAPLEMONK.saadaa_po_grn_mapping
//                       -> sd_po_grn_mapping            (last 45 days, upsert on po_detail_id|grn_id)
//   4. Vendor master    saadaa-wh.MAPLEMONK.Easyecom_Saadaa_vendors
//                       -> vendor_master_data           (code->name only, updates existing rows)
//
// Runs as YOU via Application Default Credentials; the query bills to saadaa-wh.
// Unlike sync-extra.mjs / sync-product-master.mjs (full refresh + mark-and-sweep),
// this NEVER sweeps — it only appends new rows and updates changed ones. Vendor
// master is HYBRID: GCP owns vendor_name; the Google Sheet still feeds the capacity
// model (type/merchant/machines/karigar), so we only update names of existing vendors.
//
// Usage:
//   node sync-daily.mjs                # product master + DOQ + GRN (45d) + vendor master
//   node sync-daily.mjs --test         # small pull per source, prints samples, still writes
//   node sync-daily.mjs vendor-master  # just one:  product-master | doq | grn | vendor-master
// =====================================================================

import { readFileSync } from 'node:fs';
import { BigQuery } from '@google-cloud/bigquery';

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
const ONLY = process.argv.find((a) => ['product-master', 'doq', 'grn', 'vendor-master'].includes(a));
const GRN_WINDOW_DAYS = 45;

const { SUPABASE_URL, SUPABASE_SERVICE_ROLE, BQ_BILLING_PROJECT = 'saadaa-wh' } = process.env;
if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE) {
  console.error('Set SUPABASE_URL + SUPABASE_SERVICE_ROLE in backfill/.env.');
  process.exit(1);
}
console.log(`Target: ${SUPABASE_URL}  (${new Date().toISOString()})`);

const bq = new BigQuery({ projectId: BQ_BILLING_PROJECT, location: 'asia-south1' });
const flat = (v) => (v && typeof v === 'object' && 'value' in v ? v.value : v);

const PRODUCT_MASTER_COLS = new Set([
  'sku', 'mrp', 'c_id', 'cost', 'size', 'brand', 'cp_id', 'width', 'active', 'colour',
  'height', 'length', 'weight', 'brand_id', 'hsn_code', 'model_no', 'tax_rate', 'inventory',
  'created_at', 'product_id', 'updated_at', 'category_id', 'description', 'expiry_type',
  'company_name', 'cp_inventory', 'product_name', 'product_type', 'category_name',
  'accounting_sku', 'accounting_unit', 'product_image_url', 'product_shelf_life',
  'cp_sub_products_count',
]);
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
      allowed: PRODUCT_MASTER_COLS,
      keyOf: (r) => r.sku || null,
      query: `SELECT * FROM \`saadaa-wh.MAPLEMONK.EasyEcom_SAADAA_product_master\`
              ${TEST ? 'LIMIT 20' : ''}`,
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

  if (!ONLY || ONLY === 'vendor-master') {
    await syncVendorMaster();
  }

  console.log('\nDaily sync complete.');
}

main().catch((err) => {
  console.error('\nsync-daily failed:', err.message || err);
  process.exit(1);
});
