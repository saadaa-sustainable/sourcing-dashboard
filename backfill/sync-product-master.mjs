// =====================================================================
// Sync the EasyEcom Item/Product Master from BigQuery into Supabase.
//   saadaa-wh.MAPLEMONK.EasyEcom_SAADAA_product_master  ->  sd_ee_product_master
//
// Runs as YOU via Application Default Credentials (same as sync-extra.mjs);
// the query bills to saadaa-wh. Full refresh via mark-and-sweep on sku.
//
// Usage:
//   node sync-product-master.mjs --test   # small pull, prints a sample, still writes
//   node sync-product-master.mjs          # full refresh
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
  SUPABASE_URL,
  SUPABASE_SERVICE_ROLE,
  BQ_BILLING_PROJECT = 'saadaa-wh',
} = process.env;

if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE) {
  console.error('Set SUPABASE_URL + SUPABASE_SERVICE_ROLE in backfill/.env.');
  process.exit(1);
}
console.log(`Target: ${SUPABASE_URL}`);

const bq = new BigQuery({ projectId: BQ_BILLING_PROJECT, location: 'asia-south1' });
const flat = (v) => (v && typeof v === 'object' && 'value' in v ? v.value : v);

// All source columns are STRING; _airbyte_* metadata is dropped.
const COLS = new Set([
  'sku', 'mrp', 'c_id', 'cost', 'size', 'brand', 'cp_id', 'width', 'active', 'colour',
  'height', 'length', 'weight', 'brand_id', 'hsn_code', 'model_no', 'tax_rate', 'inventory',
  'created_at', 'product_id', 'updated_at', 'category_id', 'description', 'expiry_type',
  'company_name', 'cp_inventory', 'product_name', 'product_type', 'category_name',
  'accounting_sku', 'accounting_unit', 'product_image_url', 'product_shelf_life',
  'cp_sub_products_count',
]);

function pick(r) {
  const out = {};
  for (const [k, v] of Object.entries(r)) {
    const key = k.toLowerCase();
    if (COLS.has(key)) out[key] = flat(v);
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

async function main() {
  const runStart = new Date().toISOString();
  console.log('[product_master] querying BigQuery…');
  const [rows] = await bq.query({
    location: 'asia-south1',
    query: `SELECT * FROM \`saadaa-wh.MAPLEMONK.EasyEcom_SAADAA_product_master\`
            ${TEST ? 'LIMIT 20' : ''}`,
  });

  const mapped = [];
  const seen = new Set();
  for (const r of rows) {
    const row = pick(r);
    if (!row.sku || seen.has(row.sku)) continue; // sku is the key; guard dupes
    seen.add(row.sku);
    row.synced_at = runStart;
    mapped.push(row);
  }
  console.log(`[product_master] ${mapped.length} rows to write.`);
  if (TEST) console.log(JSON.stringify(mapped.slice(0, 2), null, 2));

  const BATCH = 500;
  let done = 0;
  for (let i = 0; i < mapped.length; i += BATCH) {
    await supa('POST', 'sd_ee_product_master?on_conflict=sku', mapped.slice(i, i + BATCH));
    done += Math.min(BATCH, mapped.length - i);
    process.stdout.write(`\r[product_master] upserted ${done}/${mapped.length}`);
  }
  await supa('DELETE', `sd_ee_product_master?synced_at=lt.${encodeURIComponent(runStart)}`);
  console.log('\n[product_master] done (stale rows swept).');
}

main().catch((err) => {
  console.error('\nsync-product-master failed:', err.message || err);
  process.exit(1);
});
