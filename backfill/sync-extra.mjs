// =====================================================================
// Sync two extra BigQuery tables into the NPD-Tracker v7 Supabase, alongside
// the ~5-min PO job. Runs as YOU via Application Default Credentials (same as
// backfill-po.mjs) — no service account for BigQuery.
//
//   saadaa-wh.MAPLEMONK.saadaa_inventory_planning  -> sd_inventory_planning
//        (LATEST date_day snapshot only — the full table is 11.9M rows)
//   saadaa-wh.MAPLEMONK.saadaa_po_grn_mapping       -> sd_po_grn_mapping (full)
//
// Full-refresh via mark-and-sweep: upsert the whole snapshot with one run
// timestamp, then delete rows whose synced_at predates the run.
//
// Env (backfill/.env):
//   NPD_SUPABASE_URL           = https://xntnqlrcxznximxbskut.supabase.co
//   NPD_SUPABASE_SERVICE_ROLE  = <NPD project service_role key>
//   BQ_BILLING_PROJECT         = saadaa-wh   (optional)
//
// Usage:
//   node sync-extra.mjs --test   # small pull, prints a sample, still writes
//   node sync-extra.mjs          # full refresh of both tables
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
const {
  NPD_SUPABASE_URL,
  NPD_SUPABASE_SERVICE_ROLE,
  BQ_BILLING_PROJECT = 'saadaa-wh',
} = process.env;

if (!NPD_SUPABASE_URL || !NPD_SUPABASE_SERVICE_ROLE) {
  console.error(
    'Missing NPD_SUPABASE_URL or NPD_SUPABASE_SERVICE_ROLE — set them in backfill/.env\n' +
      '(Settings → API → Project URL and the service_role key of the NPD-Tracker v7 project).',
  );
  process.exit(1);
}

const bq = new BigQuery({ projectId: BQ_BILLING_PROJECT, location: 'asia-south1' });
const flat = (v) => (v && typeof v === 'object' && 'value' in v ? v.value : v);

// Only these columns are written — anything else BigQuery returns is ignored, so
// an added source column never breaks the run (it just won't land until added here).
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
  const res = await fetch(`${NPD_SUPABASE_URL}/rest/v1/${path}`, {
    method,
    headers: {
      apikey: NPD_SUPABASE_SERVICE_ROLE,
      Authorization: `Bearer ${NPD_SUPABASE_SERVICE_ROLE}`,
      'Content-Type': 'application/json',
      Prefer: 'resolution=merge-duplicates,return=minimal',
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  if (!res.ok) throw new Error(`Supabase ${method} ${path} → ${res.status}: ${await res.text()}`);
}

async function syncTable({ label, table, query, allowed, keyOf }) {
  const runStart = new Date().toISOString();
  console.log(`\n[${label}] querying BigQuery…`);
  const [rows] = await bq.query({ query, location: 'asia-south1' });

  const mapped = [];
  for (const r of rows) {
    const row = pick(r, allowed);
    const key = keyOf(row);
    if (!key) continue;
    row.row_key = key;
    row.synced_at = runStart;
    mapped.push(row);
  }
  console.log(`[${label}] ${mapped.length} rows to write.`);
  if (TEST) console.log(JSON.stringify(mapped.slice(0, 2), null, 2));

  const BATCH = 500;
  let done = 0;
  for (let i = 0; i < mapped.length; i += BATCH) {
    await supa('POST', `${table}?on_conflict=row_key`, mapped.slice(i, i + BATCH));
    done += Math.min(BATCH, mapped.length - i);
    process.stdout.write(`\r[${label}] upserted ${done}/${mapped.length}`);
  }
  // Sweep rows not present in this snapshot.
  await supa('DELETE', `${table}?synced_at=lt.${encodeURIComponent(runStart)}`);
  console.log(`\n[${label}] done (stale rows swept).`);
}

async function main() {
  // Pick which to run:  node sync-extra.mjs [inventory|grn]  (default: both).
  // inventory_planning is a DAILY snapshot — schedule it ~daily; po_grn_mapping
  // updates as goods are received — schedule it on the ~5-min job.
  const only = process.argv.find((a) => a === 'inventory' || a === 'grn');

  if (only !== 'grn') {
    await syncTable({
      label: 'inventory_planning',
      table: 'sd_inventory_planning',
      allowed: INVENTORY_COLS,
      keyOf: (r) => (r.sku ? `${r.sku}|${r.warehouse ?? ''}` : null),
      query: `
        SELECT * FROM \`saadaa-wh.MAPLEMONK.saadaa_inventory_planning\`
        WHERE date_day = (SELECT MAX(date_day) FROM \`saadaa-wh.MAPLEMONK.saadaa_inventory_planning\`)
        ${TEST ? 'LIMIT 20' : ''}`,
    });
  }

  if (only !== 'inventory') {
    await syncTable({
      label: 'po_grn_mapping',
      table: 'sd_po_grn_mapping',
      allowed: GRN_COLS,
      keyOf: (r) =>
        r.po_detail_id ? `${r.po_detail_id}|${r.grn_id ?? ''}` : null,
      query: `
        SELECT * FROM \`saadaa-wh.MAPLEMONK.saadaa_po_grn_mapping\`
        ${TEST ? 'LIMIT 20' : ''}`,
    });
  }

  console.log('\nSync complete.');
}

main().catch((err) => {
  console.error('\nsync-extra failed:', err.message || err);
  process.exit(1);
});
