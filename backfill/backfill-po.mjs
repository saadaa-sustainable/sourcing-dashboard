// =====================================================================
// One-time (re-runnable) backfill of PO history:
//   BigQuery  saadaa-wh.MAPLEMONK.EE_purchase_orders(_po_items)
//        ->  Supabase  public.sd_po_master_raw
//
// Runs as YOU via Application Default Credentials (gcloud auth
// application-default login). The query bills to saadaa-wh. No service
// account, no card. Safe to re-run — it upserts on po_detail_id.
//
// Usage:
//   node backfill-po.mjs --test     # 5 rows, prints a sample, upserts them
//   node backfill-po.mjs            # full ~64k backfill
// =====================================================================

import { readFileSync } from 'node:fs';
import { BigQuery } from '@google-cloud/bigquery';

// --- minimal .env loader (no dotenv dependency) ---
try {
  const env = readFileSync(new URL('./.env', import.meta.url), 'utf8');
  for (const line of env.split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
    if (m && process.env[m[1]] === undefined) {
      process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
    }
  }
} catch {
  /* no .env file — rely on real environment variables */
}

const TEST = process.argv.includes('--test');
const {
  SUPABASE_URL,
  SUPABASE_SERVICE_ROLE,
  BQ_BILLING_PROJECT = 'saadaa-wh',
} = process.env;

if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE) {
  console.error('Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE (set them in backfill/.env).');
  process.exit(1);
}

const bq = new BigQuery({ projectId: BQ_BILLING_PROJECT, location: 'asia-south1' });

// Upsert straight to PostgREST with fetch — avoids @supabase/supabase-js, whose
// newest version needs native WebSocket (Node 22+). Node 18+ has global fetch.
async function upsertBatch(rows) {
  const res = await fetch(
    `${SUPABASE_URL}/rest/v1/sd_po_master_raw?on_conflict=po_detail_id`,
    {
      method: 'POST',
      headers: {
        apikey: SUPABASE_SERVICE_ROLE,
        Authorization: `Bearer ${SUPABASE_SERVICE_ROLE}`,
        'Content-Type': 'application/json',
        Prefer: 'resolution=merge-duplicates,return=minimal',
      },
      body: JSON.stringify(rows),
    },
  );
  if (!res.ok) {
    throw new Error(`Supabase upsert ${res.status}: ${await res.text()}`);
  }
}

const QUERY = `
SELECT
  i.purchase_order_detail_id AS po_detail_id,
  h.po_id, h.po_number, h.po_ref_num,
  SAFE_CAST(h.po_status_id AS INT64) AS po_status_code,
  h.vendor_code, h.vendor_name, h.po_created_warehouse AS warehouse,
  i.sku, i.product_id, i.product_description,
  SAFE_CAST(i.original_quantity AS NUMERIC) AS original_qty,
  SAFE_CAST(i.pending_quantity  AS NUMERIC) AS pending_qty,
  SAFE_CAST(i.item_price          AS NUMERIC) AS item_price,
  SAFE_CAST(h.total_po_value      AS NUMERIC) AS total_po_value,
  SAFE_CAST(SUBSTR(h.po_created_date,1,10)        AS DATE) AS po_date,
  SAFE_CAST(SUBSTR(h.po_updated_date,1,10)        AS DATE) AS po_updated_date,
  SAFE_CAST(SUBSTR(h.expected_delivery_date,1,10) AS DATE) AS expected_delivery_date
FROM \`saadaa-wh.MAPLEMONK.EE_purchase_orders\` h
JOIN \`saadaa-wh.MAPLEMONK.EE_purchase_orders_po_items\` i
  ON i._airbyte_EE_purchase_orders_hashid = h._airbyte_EE_purchase_orders_hashid
QUALIFY ROW_NUMBER() OVER (
  PARTITION BY i.purchase_order_detail_id
  ORDER BY i._airbyte_emitted_at DESC
) = 1
${TEST ? 'LIMIT 5' : ''}
`;

const STATUS_NAME = { 2: 'Waiting', 3: 'Approved', 4: 'Rejected', 5: 'Completed', 7: 'cancelled' };

// SKU convention (validated against the sheet): <product_code><2-char colour>_<size>
//   SDRPTBR_XS -> variant SDRPTBR, product_code SDRPT, size XS
function derive(sku) {
  if (!sku) return { product_variant: null, product_code: null, size: null };
  const s = String(sku);
  const m = s.match(/^(.*)_([^_]+)$/);
  const product_variant = m ? m[1] : s;
  const size = m ? m[2] : null;
  const product_code = product_variant.length > 2 ? product_variant.slice(0, -2) : product_variant;
  return { product_variant, product_code, size };
}

// BigQuery returns DATE/NUMERIC as wrapper objects ({ value }); flatten them.
const flat = (v) => (v && typeof v === 'object' && 'value' in v ? v.value : v);
const str = (v) => { const f = flat(v); return f == null ? null : String(f); };
const num = (v) => { const f = flat(v); if (f == null || f === '') return null; const n = Number(f); return Number.isFinite(n) ? n : null; };

function mapRow(r) {
  const { product_variant, product_code, size } = derive(str(r.sku));
  const code = num(r.po_status_code);
  return {
    po_detail_id: str(r.po_detail_id),
    po_id: str(r.po_id),
    po_number: str(r.po_number),
    po_ref_num: str(r.po_ref_num),
    po_status_code: code,
    po_status: code == null ? null : (STATUS_NAME[code] ?? String(code)),
    vendor_code: str(r.vendor_code),
    vendor_name: str(r.vendor_name),
    warehouse: str(r.warehouse),
    sku: str(r.sku),
    product_id: str(r.product_id),
    product_code,
    product_variant,
    size,
    product_description: str(r.product_description),
    original_qty: num(r.original_qty),
    pending_qty: num(r.pending_qty),
    item_price: num(r.item_price),
    total_po_value: num(r.total_po_value),
    po_date: str(r.po_date),
    po_updated_date: str(r.po_updated_date),
    expected_delivery_date: str(r.expected_delivery_date),
  };
}

async function main() {
  console.log(TEST ? 'TEST run — 5 rows.' : 'Full backfill — querying BigQuery…');
  const [rows] = await bq.query({ query: QUERY, location: 'asia-south1' });
  const mapped = rows.map(mapRow).filter((r) => r.po_detail_id);
  console.log(`Fetched ${mapped.length} PO lines from BigQuery.`);

  if (TEST) {
    console.log('Sample of what will be written:');
    console.log(JSON.stringify(mapped, null, 2));
  }

  const BATCH = 500;
  let done = 0;
  for (let i = 0; i < mapped.length; i += BATCH) {
    const chunk = mapped.slice(i, i + BATCH);
    await upsertBatch(chunk);
    done += chunk.length;
    process.stdout.write(`\rUpserted ${done}/${mapped.length}`);
  }
  console.log(`\nDone. ${mapped.length} PO lines are in sd_po_master_raw.`);
}

main().catch((err) => {
  console.error('\nBackfill failed:', err.message || err);
  process.exit(1);
});
