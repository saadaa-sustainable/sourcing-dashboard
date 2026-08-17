// =====================================================================
// Pull customer RETURNS + EXCHANGES from EasyEcom into Supabase.
//   POST /access/token                 -> JWT
//   GET  /orders/getAllReturns          -> credit_notes[] + items[], paged via nextUrl
//        -> public.sd_ee_return  (one row per returned line-item, upsert on row_key)
//
// Returns and exchanges share this endpoint; exchange = replacement_order == 1.
// Privacy: only business fields are written (sku, reason, inventory_status, dates,
// ids) — NO customer name / address / phone. `nextUrl` is a RELATIVE path.
//
// Creds from backfill/.env (same as fetch-ee-po.mjs):
//   EE_EMAIL, EE_PASSWORD, EE_API_KEY, EE_LOCATION_KEY, EE_START_DATE
//   SUPABASE_URL, SUPABASE_SERVICE_ROLE
//
// Usage:  node fetch-ee-returns.mjs --test   |   node fetch-ee-returns.mjs
// =====================================================================
import { readFileSync } from 'node:fs';

try {
  const env = readFileSync(new URL('./.env', import.meta.url), 'utf8');
  for (const line of env.split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
    if (m && process.env[m[1]] === undefined) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
  }
} catch { /* rely on real env vars */ }

const TEST = process.argv.includes('--test');
const {
  EE_EMAIL, EE_PASSWORD, EE_API_KEY, EE_LOCATION_KEY,
  EE_START_DATE = '2025-01-01 00:00:00',
  EE_BASE_URL = 'https://api.easyecom.io',
  SUPABASE_URL, SUPABASE_SERVICE_ROLE,
} = process.env;
for (const [k, v] of Object.entries({ EE_EMAIL, EE_PASSWORD, EE_API_KEY, EE_LOCATION_KEY, SUPABASE_URL, SUPABASE_SERVICE_ROLE })) {
  if (!v) { console.error(`Missing ${k} (set it in backfill/.env).`); process.exit(1); }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const num = (v) => { if (v == null || v === '') return null; const n = Number(v); return Number.isFinite(n) ? n : null; };
const str = (v) => (v == null ? null : String(v));
const date = (v) => { const s = str(v); return s ? s.slice(0, 10) : null; };

async function getToken() {
  const r = await fetch(`${EE_BASE_URL}/access/token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-api-key': EE_API_KEY },
    body: JSON.stringify({ email: EE_EMAIL, password: EE_PASSWORD, location_key: EE_LOCATION_KEY }),
  });
  const b = await r.text();
  if (!r.ok) throw new Error(`Token failed (HTTP ${r.status}): ${b}`);
  const t = JSON.parse(b)?.data?.token?.jwt_token;
  if (!t) throw new Error(`No jwt_token in response:\n${b}`);
  return t;
}

function mapRows(cn) {
  const out = [];
  const base = {
    credit_note_id: num(cn.credit_note_id),
    invoice_id: num(cn.invoice_id),
    order_id: num(cn.order_id),
    reference_code: str(cn.reference_code),
    replacement_order: num(cn.replacement_order),
    return_type: str(cn.return_type),
    return_date: date(cn.return_date),
    credit_note_date: date(cn.credit_note_date),
    marketplace: str(cn.marketplace),
    company_name: str(cn.company_name),
  };
  for (const it of cn.items ?? []) {
    const sku = str(it.sku);
    const suborder = num(it.suborder_id);
    const rk = `${base.credit_note_id}|${suborder ?? ''}|${sku ?? ''}`;
    out.push({
      row_key: rk,
      ...base,
      sku,
      product_id: num(it.product_id),
      company_product_id: num(it.company_product_id),
      suborder_id: suborder,
      return_reason: str(it.return_reason),
      inventory_status: str(it.inventory_status),
      returned_qty: num(it.returned_item_quantity),
      synced_at: new Date().toISOString(),
    });
  }
  return out;
}

async function upsert(rows) {
  // Dedupe row_key within the batch (PostgREST rejects duplicate conflict keys).
  const seen = new Map();
  for (const r of rows) seen.set(r.row_key, r);
  const body = [...seen.values()];
  const res = await fetch(`${SUPABASE_URL}/rest/v1/sd_ee_return?on_conflict=row_key`, {
    method: 'POST',
    headers: {
      apikey: SUPABASE_SERVICE_ROLE,
      Authorization: `Bearer ${SUPABASE_SERVICE_ROLE}`,
      'Content-Type': 'application/json',
      Prefer: 'resolution=merge-duplicates,return=minimal',
    },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`Supabase upsert ${res.status}: ${await res.text()}`);
}

async function main() {
  console.log(TEST ? 'TEST run — first page only.' : `Full pull of returns/exchanges from ${EE_START_DATE}`);
  const jwt = await getToken();
  const H = { Authorization: `Bearer ${jwt}`, 'x-api-key': EE_API_KEY };

  let url = `${EE_BASE_URL}/orders/getAllReturns?created_after=${encodeURIComponent(EE_START_DATE)}`;
  let pages = 0, cns = 0, items = 0, guard = 0;
  let buffer = [];
  while (url && guard++ < 5000) {
    const r = await fetch(url, { headers: H });
    if (r.status === 429 || r.status === 403) { await sleep(2000); continue; }
    if (!r.ok) throw new Error(`getAllReturns failed (HTTP ${r.status}):\n${(await r.text()).slice(0, 200)}`);
    const j = JSON.parse(await r.text());
    const list = j?.data?.credit_notes ?? [];
    for (const cn of list) { cns++; const rows = mapRows(cn); items += rows.length; buffer.push(...rows); }
    if (buffer.length >= 500) { await upsert(buffer); buffer = []; }
    pages++;
    process.stdout.write(`\rpage ${pages} · credit_notes ${cns} · items ${items}`);
    const nx = j?.data?.nextUrl;
    url = nx ? (nx.startsWith('http') ? nx : EE_BASE_URL + nx) : null;
    if (TEST) break;
    await sleep(150);
  }
  if (buffer.length) await upsert(buffer);
  console.log(`\nDone. ${cns} credit-notes, ${items} line-items upserted into sd_ee_return over ${pages} page(s).`);
}

main().catch((e) => { console.error('\nfetch-ee-returns failed:', e.message || e); process.exit(1); });
