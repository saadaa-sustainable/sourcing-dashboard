// =====================================================================
// Pull Purchase Orders DIRECTLY from the EasyEcom API into Supabase.
//   POST /access/token                    -> JWT (per user + location, 90d)
//   GET  /account/v1/api/locations         -> accessible location keys (multi-wh)
//   GET  /wms/V2/getPurchaseOrderDetails    -> PO headers + nested po_items, paged via nextUrl
//        -> public.sd_ee_po  (upsert on po_id)
//
// ALL statuses, from 2025-01-01 (so "POs given" is available, not just Completed).
// Feeds the sd_vendor_po_performance view (Completion / On-Time / Delay rates).
// EDD is NOT returned by this endpoint; the view joins it from sd_po_master_raw.
//
// Every request needs BOTH headers: Authorization: Bearer <jwt> AND x-api-key.
// New API keys are on the low "Default" tier -> 429/403 backoff + retry.
//
// Credentials come from backfill/.env (NEVER commit them):
//   EE_EMAIL, EE_PASSWORD, EE_API_KEY, EE_LOCATION_KEY  (seed warehouse)
//   EE_ALL_LOCATIONS = true|false   (default false = seed only)
//   EE_START_DATE = '2025-01-01 00:00:00'
//   SUPABASE_URL, SUPABASE_SERVICE_ROLE   (already set for backfill-po.mjs)
//
// Usage:
//   node fetch-ee-po.mjs --test     # first page only, prints a sample, still writes
//   node fetch-ee-po.mjs            # full pull
// =====================================================================

import { readFileSync } from 'node:fs';

// --- minimal .env loader (no dotenv dependency) ---
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
  EE_EMAIL,
  EE_PASSWORD,
  EE_API_KEY,
  EE_LOCATION_KEY,
  EE_ALL_LOCATIONS = 'false',
  EE_START_DATE = '2025-01-01 00:00:00',
  EE_BASE_URL = 'https://api.easyecom.io',
  SUPABASE_URL,
  SUPABASE_SERVICE_ROLE,
} = process.env;

for (const [k, v] of Object.entries({ EE_EMAIL, EE_PASSWORD, EE_API_KEY, EE_LOCATION_KEY, SUPABASE_URL, SUPABASE_SERVICE_ROLE })) {
  if (!v) {
    console.error(`Missing ${k} (set it in backfill/.env).`);
    process.exit(1);
  }
}

const PO_STATUS = {
  1: 'Open', 2: 'Waiting for Approval', 3: 'Approved', 4: 'Rejected', 5: 'Completed',
  6: 'Pending on Supplier', 7: 'cancelled', 8: 'Payment Pending', 9: 'Payment Done',
  11: 'Shipped to FF', 12: 'Pending Dispatch on FF', 13: 'Shipped', 14: 'Shipped by FF',
  15: 'Received by FF', 16: 'Invoice done by Vendor',
};

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const num = (v) => { if (v == null || v === '') return null; const n = Number(v); return Number.isFinite(n) ? n : null; };
const str = (v) => (v == null ? null : String(v));

/** POST /access/token for a location_key -> JWT string. */
async function getAccessToken(locationKey) {
  const res = await fetch(`${EE_BASE_URL}/access/token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-api-key': EE_API_KEY },
    body: JSON.stringify({ email: EE_EMAIL, password: EE_PASSWORD, location_key: locationKey }),
  });
  const body = await res.text();
  if (!res.ok) throw new Error(`Token request failed (HTTP ${res.status}): ${body}`);
  const json = JSON.parse(body);
  const token = json?.data?.token?.jwt_token;
  if (!token) throw new Error(`No jwt_token in response:\n${body}`);
  return token;
}

const authHeaders = (token) => ({ Authorization: `Bearer ${token}`, 'x-api-key': EE_API_KEY });

/** GET /account/v1/api/locations -> [{ location_key, companyname }, ...]. */
async function getChildLocations(token) {
  const res = await fetch(`${EE_BASE_URL}/account/v1/api/locations`, { headers: authHeaders(token) });
  const body = await res.text();
  if (!res.ok) throw new Error(`getChildLocations failed (HTTP ${res.status}): ${body}`);
  const json = JSON.parse(body);
  return Array.isArray(json.data) ? json.data : [];
}

/** Page through getPurchaseOrderDetails via nextUrl for one token/location. */
async function fetchPOsForToken(token) {
  const all = [];
  const params = new URLSearchParams({ limit: '10' });
  if (EE_START_DATE) params.set('created_after', EE_START_DATE);
  // No po_status_id -> ALL statuses (so "POs given" is captured).
  let url = `${EE_BASE_URL}/wms/V2/getPurchaseOrderDetails?${params.toString()}`;

  let guard = 0;
  while (url && guard++ < 100000) {
    const res = await fetch(url, { headers: authHeaders(token) });
    if (res.status === 429 || res.status === 403) { await sleep(2000); continue; } // rate-limited
    const body = await res.text();
    if (!res.ok) throw new Error(`getPurchaseOrderDetails failed (HTTP ${res.status}):\n${body}`);
    const json = JSON.parse(body);
    if (Array.isArray(json.data)) all.push(...json.data);
    url = json.nextUrl || null;
    if (TEST) break; // first page only
    if (json.data?.length) process.stdout.write(`\r  fetched ${all.length} PO(s)…`);
    await sleep(250); // gentle on the Default tier
  }
  return all;
}

function mapPo(po) {
  const id = num(po.po_id);
  if (id == null) return null;
  const statusId = num(po.po_status_id);
  return {
    po_id: id,
    po_number: str(po.po_number),
    po_ref_num: str(po.po_ref_num),
    po_status_id: statusId,
    po_status: statusId != null ? PO_STATUS[statusId] ?? String(statusId) : null,
    po_created_date: str(po.po_created_date),
    po_updated_date: str(po.po_updated_date),
    po_created_warehouse: str(po.po_created_warehouse),
    po_created_location_key: str(po.po_created_location_key),
    vendor_name: str(po.vendor_name),
    vendor_code: str(po.vendor_code),
    vendor_c_id: num(po.vendor_c_id),
    vendor_location_key: str(po.vendor_location_key),
    total_po_value: num(po.total_po_value),
    synced_at: new Date().toISOString(),
    raw: po,
  };
}

async function upsertBatch(rows) {
  const res = await fetch(`${SUPABASE_URL}/rest/v1/sd_ee_po?on_conflict=po_id`, {
    method: 'POST',
    headers: {
      apikey: SUPABASE_SERVICE_ROLE,
      Authorization: `Bearer ${SUPABASE_SERVICE_ROLE}`,
      'Content-Type': 'application/json',
      Prefer: 'resolution=merge-duplicates,return=minimal',
    },
    body: JSON.stringify(rows),
  });
  if (!res.ok) throw new Error(`Supabase upsert ${res.status}: ${await res.text()}`);
}

async function main() {
  console.log(TEST ? 'TEST run — first page only.' : 'Full pull — all statuses from ' + EE_START_DATE);
  const seedToken = await getAccessToken(EE_LOCATION_KEY);

  // Multi-warehouse: a token is scoped to one location, so re-auth per location.
  let locations = [{ location_key: EE_LOCATION_KEY }];
  if (String(EE_ALL_LOCATIONS).toLowerCase() === 'true') {
    locations = await getChildLocations(seedToken);
    console.log(`Fetching across ${locations.length} location(s).`);
  }

  const byId = new Map(); // de-dupe by po_id across locations
  for (const loc of locations) {
    const token = loc.location_key === EE_LOCATION_KEY ? seedToken : await getAccessToken(loc.location_key);
    const pos = await fetchPOsForToken(token);
    for (const po of pos) if (po?.po_id != null) byId.set(String(po.po_id), po);
    console.log(`\n[${loc.location_key}] ${pos.length} PO(s); ${byId.size} unique so far.`);
  }

  const rows = [...byId.values()].map(mapPo).filter(Boolean);
  console.log(`Mapped ${rows.length} PO header(s).`);
  if (TEST) console.log(JSON.stringify(rows.slice(0, 2), null, 2));

  const BATCH = 500;
  for (let i = 0; i < rows.length; i += BATCH) {
    await upsertBatch(rows.slice(i, i + BATCH));
    process.stdout.write(`\rUpserted ${Math.min(i + BATCH, rows.length)}/${rows.length}`);
  }
  console.log('\nDone. Refresh sd_vendor_po_performance to see the vendor rates.');
}

main().catch((err) => {
  console.error('\nfetch-ee-po failed:', err.message || err);
  process.exit(1);
});
