// =====================================================================
// OOS Calculation backfill:  BigQuery -> Supabase public.sd_oos_calculation
//
// Sources (fixed by decision — do not substitute):
//   DOQ / inventory / attributes : saadaa-wh.MAPLEMONK.saadaa_inventory_planning
//   (GRN, product-master launch date, raw sales come in later passes.)
//
// One row per SKU, latest snapshot day, 45-day metrics straight from the source
// (doq_45, oos_days_45, total_sales_in_last_45_inventory_days). Multi-warehouse
// rows are collapsed: stock/in-process SUMmed, sku-level metrics MAXed.
//
// Columns still PENDING a source/formula (left null here, filled in later passes):
//   product_code, new_size, total_inventory_days, total_available_days, launch_date,
//   product_class, sales_value, sales_leakage, cancelled, returned, com_status, unique_key
//
// Env in backfill/.env: SUPABASE_URL, SUPABASE_SERVICE_ROLE, BQ_BILLING_PROJECT.
// Usage:  node backfill-oos.mjs --test   |   node backfill-oos.mjs
// =====================================================================
import { readFileSync } from 'node:fs';
import { BigQuery } from '@google-cloud/bigquery';

try {
  const env = readFileSync(new URL('./.env', import.meta.url), 'utf8');
  for (const line of env.split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
    if (m && process.env[m[1]] === undefined) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
  }
} catch { /* real env */ }

const TEST = process.argv.includes('--test');
const { SUPABASE_URL, SUPABASE_SERVICE_ROLE, BQ_BILLING_PROJECT = 'saadaa-wh' } = process.env;
if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE) { console.error('Missing SUPABASE_URL / SUPABASE_SERVICE_ROLE in backfill/.env'); process.exit(1); }

const bq = new BigQuery({ projectId: BQ_BILLING_PROJECT, location: 'asia-south1' });
const flat = (v) => (v && typeof v === 'object' && 'value' in v ? v.value : v);
const str = (v) => { const f = flat(v); return f == null || f === '' ? null : String(f); };
const num = (v) => { const f = flat(v); if (f == null || f === '') return null; const n = Number(f); return Number.isFinite(n) ? n : null; };
const int = (v) => { const n = num(v); return n == null ? null : Math.round(n); };

const QUERY = `
WITH latest AS (
  SELECT * FROM \`saadaa-wh.MAPLEMONK.saadaa_inventory_planning\`
  WHERE date_day = (SELECT MAX(date_day) FROM \`saadaa-wh.MAPLEMONK.saadaa_inventory_planning\`)
    AND UPPER(COALESCE(Size, '')) <> 'IN METERS'   -- drop raw fabric/RM (metre) SKUs; keep garment SKUs
    -- some fabric rows carry a NULL Size, so also drop dyed-fabric/RM codes by
    -- their yarn/width/colour shape (e.g. 20CF/63/LY, 40LEA/63/CR)
    AND NOT REGEXP_CONTAINS(sku, r'^[^/]+/[^/]+/[^/]+$')
),
agg AS (
  SELECT
    sku,
    ANY_VALUE(product_state)                                   AS product_status,
    NULLIF(TRIM(ANY_VALUE(Category)), '')                      AS product_code,
    -- gender initial + wear type, e.g. "F TOP WEAR" (the SDAFD-style code lives in product_code)
    CASE WHEN NULLIF(TRIM(ANY_VALUE(CategoryType)), '') IS NOT NULL THEN
      TRIM(CONCAT(
        CASE WHEN UPPER(TRIM(COALESCE(ANY_VALUE(Gender), ''))) IN ('WOMEN','FEMALE','F') THEN 'F'
             WHEN UPPER(TRIM(COALESCE(ANY_VALUE(Gender), ''))) IN ('MEN','MALE','M') THEN 'M'
             ELSE '' END,
        ' ', UPPER(TRIM(ANY_VALUE(CategoryType)))))
    END                                                        AS category_with_gender,
    ANY_VALUE(RM_code)                                         AS rm_code,
    ANY_VALUE(Dyed_Fabric_SKU)                                 AS dyed_fabric_sku,
    ANY_VALUE(Product_Variant)                                 AS product_variant,
    ANY_VALUE(product_name)                                    AS product_name,
    ANY_VALUE(Color)                                           AS color,
    ANY_VALUE(Size)                                            AS size,
    ANY_VALUE(WEAVE_TYPE)                                      AS weave_type,
    MAX(oos_days_45)                                           AS total_oos_days,
    MAX(total_sales_in_last_45_inventory_days)                 AS total_qty_sold,
    MAX(doq_45)                                                AS doq_45,
    SUM(current_stock)                                         AS current_stock,
    SUM(total_inprogress)                                      AS inprocess_stock
  FROM latest
  GROUP BY sku
)
SELECT
  sku, product_status, product_code, category_with_gender, rm_code, dyed_fabric_sku, product_variant,
  product_name, color, size, weave_type,
  total_oos_days, total_qty_sold, doq_45, current_stock, inprocess_stock,
  ROUND(SAFE_DIVIDE(current_stock, NULLIF(doq_45, 0)), 1)                     AS doh,
  ROUND(SAFE_DIVIDE(current_stock + inprocess_stock, NULLIF(doq_45, 0)), 1)   AS doh_with_inprocess
FROM agg
WHERE sku IS NOT NULL AND sku <> ''`;

function mapRow(r) {
  return {
    sku: str(r.sku),
    product_status: str(r.product_status),
    product_code: str(r.product_code),
    category_with_gender: str(r.category_with_gender),
    rm_code: str(r.rm_code),
    dyed_fabric_sku: str(r.dyed_fabric_sku),
    product_variant: str(r.product_variant),
    product_name: str(r.product_name),
    color: str(r.color),
    size: str(r.size),
    weave_type: str(r.weave_type),
    total_oos_days: int(r.total_oos_days),
    total_qty_sold: num(r.total_qty_sold),
    doq_45: num(r.doq_45),
    current_stock: int(r.current_stock),
    inprocess_stock: int(r.inprocess_stock),
    doh: num(r.doh),
    doh_with_inprocess: num(r.doh_with_inprocess),
    synced_at: new Date().toISOString(),
  };
}

async function upsertBatch(rows) {
  const res = await fetch(`${SUPABASE_URL}/rest/v1/sd_oos_calculation?on_conflict=sku`, {
    method: 'POST',
    headers: { apikey: SUPABASE_SERVICE_ROLE, Authorization: `Bearer ${SUPABASE_SERVICE_ROLE}`, 'Content-Type': 'application/json', Prefer: 'resolution=merge-duplicates,return=minimal' },
    body: JSON.stringify(rows),
  });
  if (!res.ok) throw new Error(`Supabase upsert ${res.status}: ${await res.text()}`);
}

async function main() {
  console.log(TEST ? 'TEST — first rows only.' : 'OOS backfill — querying BigQuery (saadaa_inventory_planning)…');
  const [rows] = await bq.query({ query: QUERY, location: 'asia-south1' });
  const mapped = rows.map(mapRow).filter((r) => r.sku);
  // de-dupe on sku within batch (PostgREST rejects a repeated conflict key)
  const seen = new Set();
  const deduped = mapped.filter((r) => (seen.has(r.sku) ? false : (seen.add(r.sku), true)));
  console.log(`Fetched ${rows.length} rows -> ${deduped.length} unique SKUs.`);
  if (TEST) { console.log(JSON.stringify(deduped.slice(0, 3), null, 2)); return; }
  const BATCH = 500;
  for (let i = 0; i < deduped.length; i += BATCH) {
    await upsertBatch(deduped.slice(i, i + BATCH));
    process.stdout.write(`\rUpserted ${Math.min(i + BATCH, deduped.length)}/${deduped.length}`);
  }
  console.log('\nDone.');
}
main().catch((e) => { console.error('\nbackfill-oos failed:', e.message || e); process.exit(1); });
