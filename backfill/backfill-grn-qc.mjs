// =====================================================================
// One-time (re-runnable) backfill of inbound-QC GRN data:
//   BigQuery  saadaa-wh.MAPLEMONK.EE_grn_details (header) JOIN EE_grn_details_grn_items
//        ->  Supabase  public.sd_ee_grn   (upsert on grn_detail_id)
//
// This is the bulk equivalent of the EasyEcom GET /Grn/V2/getGrnDetails (which is
// location-scoped + can't page in bulk). Each line carries the QC disposition
// (qc_pass / qc_fail / qc_pending / damaged / return_to_source / discard) with the
// vendor on the GRN header. Feeds the vendor rejection-rate factor.
//
// Runs as you via ADC (gcloud auth application-default login), bills saadaa-wh.
// Env in backfill/.env: SUPABASE_URL, SUPABASE_SERVICE_ROLE, BQ_BILLING_PROJECT.
// Usage:  node backfill-grn-qc.mjs --test   |   node backfill-grn-qc.mjs
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
const str = (v) => { const f = flat(v); return f == null ? null : String(f); };
const num = (v) => { const f = flat(v); if (f == null || f === '') return null; const n = Number(f); return Number.isFinite(n) ? n : null; };

const QUERY = `
SELECT
  SAFE_CAST(i.grn_detail_id AS INT64)            AS grn_detail_id,
  SAFE_CAST(h.grn_id AS INT64)                   AS grn_id,
  SUBSTR(h.grn_created_at, 1, 10)                AS grn_created_at,
  SUBSTR(h.grn_invoice_date, 1, 10)             AS grn_invoice_date,
  SAFE_CAST(h.po_id AS INT64)                    AS po_id,
  SAFE_CAST(h.po_number AS INT64)               AS po_number,
  h.po_ref_num, h.vendor_name,
  SAFE_CAST(h.vendor_c_id AS INT64)             AS vendor_c_id,
  SAFE_CAST(i.purchase_order_detail_id AS INT64) AS purchase_order_detail_id,
  SAFE_CAST(i.product_id AS INT64)              AS product_id,
  i.sku,
  i.original_quantity, i.received_quantity,
  i.qc_pass, i.qc_fail, i.qc_pending, i.damaged, i.return_to_source, i.discard, i.lost
FROM \`saadaa-wh.MAPLEMONK.EE_grn_details\` h
JOIN \`saadaa-wh.MAPLEMONK.EE_grn_details_grn_items\` i
  ON i._airbyte_EE_grn_details_hashid = h._airbyte_EE_grn_details_hashid
WHERE i.grn_detail_id IS NOT NULL
QUALIFY ROW_NUMBER() OVER (PARTITION BY SAFE_CAST(i.grn_detail_id AS INT64) ORDER BY h.grn_created_at DESC) = 1
${TEST ? 'LIMIT 5' : ''}
`;

function mapRow(r) {
  return {
    grn_detail_id: num(r.grn_detail_id), grn_id: num(r.grn_id),
    grn_created_at: str(r.grn_created_at), grn_invoice_date: str(r.grn_invoice_date),
    po_id: num(r.po_id), po_number: str(r.po_number), po_ref_num: str(r.po_ref_num),
    vendor_name: str(r.vendor_name), vendor_c_id: num(r.vendor_c_id),
    purchase_order_detail_id: num(r.purchase_order_detail_id), product_id: num(r.product_id), sku: str(r.sku),
    original_quantity: num(r.original_quantity), received_quantity: num(r.received_quantity),
    qc_pass: num(r.qc_pass), qc_fail: num(r.qc_fail), qc_pending: num(r.qc_pending),
    damaged: num(r.damaged), return_to_source: num(r.return_to_source), discard: num(r.discard), lost: num(r.lost),
  };
}

async function upsertBatch(rows) {
  const res = await fetch(`${SUPABASE_URL}/rest/v1/sd_ee_grn?on_conflict=grn_detail_id`, {
    method: 'POST',
    headers: { apikey: SUPABASE_SERVICE_ROLE, Authorization: `Bearer ${SUPABASE_SERVICE_ROLE}`, 'Content-Type': 'application/json', Prefer: 'resolution=merge-duplicates,return=minimal' },
    body: JSON.stringify(rows),
  });
  if (!res.ok) throw new Error(`Supabase upsert ${res.status}: ${await res.text()}`);
}

async function main() {
  console.log(TEST ? 'TEST — 5 rows.' : 'Full GRN-QC backfill — querying BigQuery…');
  const [rows] = await bq.query({ query: QUERY, location: 'asia-south1' });
  const mapped = rows.map(mapRow).filter((r) => r.grn_detail_id != null);
  console.log(`Fetched ${mapped.length} GRN line-items from BigQuery.`);
  if (TEST) { console.log(JSON.stringify(mapped.slice(0, 3), null, 2)); }
  const BATCH = 500;
  for (let i = 0; i < mapped.length; i += BATCH) {
    await upsertBatch(mapped.slice(i, i + BATCH));
    process.stdout.write(`\rUpserted ${Math.min(i + BATCH, mapped.length)}/${mapped.length}`);
  }
  console.log('\nDone.');
}
main().catch((e) => { console.error('\nbackfill-grn-qc failed:', e.message || e); process.exit(1); });
