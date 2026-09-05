// EasyCom "Complete GRN" webhook receiver — capture-first.
//
// On every call it logs the raw payload to sd_grn_webhook_log (so you can
// SEE EasyCom's real GRN JSON before locking the mapping), then best-effort
// upserts each received PO line into sd_grn_event. The field mapping in
// mapGrn() is a best guess until the real payload is seen — the whole item is
// archived in `raw` either way.
//
// This writes to the OWNED sd_grn_event table, NOT the BigQuery mirror
// sd_po_grn_mapping (which the 5-min sync DELETE-sweeps).
//
// Deploy:  supabase functions deploy easyecom-grn --no-verify-jwt
// Secret:  reuses EASYECOM_WEBHOOK_TOKEN (same token as easyecom-inventory)
//   (SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are injected automatically.)
//
// SECURITY — capture-first is a TEMPORARY DISCOVERY MODE, not a permanent stance.
// This endpoint is deployed --no-verify-jwt (no platform auth) and, by default,
// logs even unauthenticated bodies so EasyCom's real GRN JSON can be seen before
// the mapping is locked. That means anyone who finds the URL can write rows to
// sd_grn_webhook_log. Two guardrails bound the blast radius:
//   1. MAX_BODY_BYTES — oversized bodies are rejected (413) and never stored, so
//      the table cannot be flooded with huge payloads.
//   2. GRN_CAPTURE_UNAUTHED — the SUNSET SWITCH. While "1" (default) bad-auth
//      calls are still logged in full (discovery). Once the mapping is confirmed,
//      set this secret to "0": bad-auth calls then get only a minimal counter row
//      (no raw_body, no headers) and attacker JSON is no longer persisted.
// ⏳ SUNSET: flip GRN_CAPTURE_UNAUTHED=0 as soon as the real payload is captured
//    and mapGrn() is finalised. Do not leave full unauthenticated capture on
//    indefinitely. (Set via: supabase secrets set GRN_CAPTURE_UNAUTHED=0)

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_ROLE = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const WEBHOOK_TOKEN = Deno.env.get("EASYECOM_WEBHOOK_TOKEN") ?? "";
// Reject payloads larger than this (anti-flood). EasyCom GRN batches are small.
const MAX_BODY_BYTES = 1_000_000; // 1 MB
// Sunset switch: default ON (discovery). Set to "0"/"false" to stop persisting
// full unauthenticated bodies once the mapping is locked.
const CAPTURE_UNAUTHED =
  (Deno.env.get("GRN_CAPTURE_UNAUTHED") ?? "1").toLowerCase() !== "0" &&
  (Deno.env.get("GRN_CAPTURE_UNAUTHED") ?? "1").toLowerCase() !== "false";

const supabase = createClient(SUPABASE_URL, SERVICE_ROLE, {
  auth: { persistSession: false },
});

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });

const num = (v: unknown) => {
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
};
const str = (v: unknown) => (v == null ? null : String(v));
// EasyCom dates arrive in various shapes; keep only a YYYY-MM-DD prefix.
const date = (v: unknown) => {
  const s = str(v);
  if (!s) return null;
  const m = s.match(/^\d{4}-\d{2}-\d{2}/);
  return m ? m[0] : null;
};

// EasyCom may put the token in any of these places — check them all.
function extractToken(req: Request, url: URL, body: any): string | null {
  const h = req.headers;
  const candidates = [
    h.get("x-auth-token"),
    h.get("x-webhook-token"),
    h.get("x-access-token"),
    h.get("access-token"),
    h.get("token"),
    h.get("auth"),
    h.get("x-easyecom-token"),
    h.get("authorization")?.replace(/^Bearer\s+/i, "") ?? null,
    url.searchParams.get("token"),
    url.searchParams.get("auth"),
    body?.token ?? null,
    body?.auth_token ?? null,
  ];
  return candidates.find((c) => c && String(c).length > 0) ?? null;
}

// Pull the GRN line items out of whatever shape EasyCom sends.
function extractItems(body: any): any[] {
  if (Array.isArray(body)) return body;
  for (
    const key of [
      "grns",
      "grn",
      "grn_items",
      "grnItems",
      "items",
      "lines",
      "data",
      "payload",
    ]
  ) {
    if (Array.isArray(body?.[key])) return body[key];
  }
  // A single GRN object (with nested items) — flatten to its lines if present.
  if (body?.grn && Array.isArray(body.grn.items)) return body.grn.items;
  // A single line/object that looks GRN-shaped.
  if (body && (body.grn_id || body.grnId || body.po_number || body.po_detail_id)) {
    return [body];
  }
  return [];
}

// Best-guess field mapping — finalised once EasyCom's real field names are seen.
function mapGrn(it: any) {
  const grnId = num(it.grn_id ?? it.grnId ?? it.grn_invoice_id ?? it.id);
  const poDetailId = str(
    it.po_detail_id ?? it.poDetailId ?? it.po_details_id ?? it.podetail_id,
  );
  const sku = str(it.sku ?? it.SKU ?? it.sku_code ?? it.product_sku);
  // Prefer po_detail_id|grn_id; fall back so a row is never dropped.
  const rowKey =
    poDetailId && grnId != null
      ? `${poDetailId}|${grnId}`
      : grnId != null
      ? `${grnId}|${sku ?? ""}`
      : `${poDetailId ?? "?"}|${sku ?? ""}`;
  return {
    row_key: rowKey,
    grn_id: grnId,
    po_detail_id: poDetailId,
    po_number: num(it.po_number ?? it.poNumber ?? it.po_id ?? it.poId),
    po_ref_num: str(it.po_ref_num ?? it.poRefNum ?? it.po_reference ?? it.reference_number),
    sku,
    size: str(it.size ?? it.variant_size ?? it.product_size),
    warehouse: str(it.warehouse ?? it.warehouse_name ?? it.location ?? it.wh),
    vendor_code: str(it.vendor_code ?? it.vendorCode ?? it.supplier_code),
    vendor_name: str(it.vendor_name ?? it.vendorName ?? it.supplier_name ?? it.vendor),
    grn_status: str(it.grn_status ?? it.grnStatus ?? it.status),
    grn_created_date: date(it.grn_created_date ?? it.grn_date ?? it.grnCreatedDate ?? it.created_at),
    grn_invoice_date: date(it.grn_invoice_date ?? it.invoice_date ?? it.grnInvoiceDate),
    grn_invoice_number: str(it.grn_invoice_number ?? it.invoice_number ?? it.grnInvoiceNumber),
    grn_receive_quantity: num(
      it.grn_receive_quantity ?? it.receive_quantity ?? it.received_quantity ??
        it.receivedQuantity ?? it.quantity ?? it.qty,
    ),
    total_grn_value: num(
      it.total_grn_value ?? it.grn_value ?? it.total_value ?? it.value,
    ),
    received_at: new Date().toISOString(),
    raw: it,
  };
}

Deno.serve(async (req: Request) => {
  if (req.method !== "POST") return json({ ok: false, error: "POST only" }, 405);

  const url = new URL(req.url);
  const rawText = await req.text();
  // Anti-flood: refuse oversized bodies before parsing or storing anything.
  if (rawText.length > MAX_BODY_BYTES) {
    return json({ ok: false, error: "payload too large" }, 413);
  }
  let body: any = null;
  try {
    body = rawText ? JSON.parse(rawText) : null;
  } catch {
    body = { _unparsed: rawText };
  }

  const token = extractToken(req, url, body);
  const authOk = WEBHOOK_TOKEN.length > 0 && token === WEBHOOK_TOKEN;
  const items = extractItems(body);

  const eventType = str(
    body?.event ?? body?.trigger_type ?? body?.trigger ??
      url.searchParams.get("trigger") ?? "complete_grn",
  );

  if (!authOk) {
    // Bad auth. During discovery (CAPTURE_UNAUTHED) log the full body so the real
    // EasyCom payload can be inspected; after sunset, persist only a minimal
    // counter row so the table can't be filled with attacker-controlled JSON.
    if (CAPTURE_UNAUTHED) {
      const headers: Record<string, string> = {};
      req.headers.forEach((v, k) => {
        headers[k] = k.toLowerCase().includes("cookie") ? "***" : v;
      });
      await supabase.from("sd_grn_webhook_log").insert({
        event_type: eventType,
        item_count: items.length,
        auth_ok: false,
        headers,
        raw_body: body,
      });
    } else {
      await supabase.from("sd_grn_webhook_log").insert({
        event_type: eventType,
        item_count: items.length,
        auth_ok: false,
        note: "unauthenticated (body not captured; discovery mode off)",
      });
    }
    return json({ ok: true, auth_ok: false, logged: true });
  }

  // Authenticated: capture the full body (audit trail for the real integration).
  const headers: Record<string, string> = {};
  req.headers.forEach((v, k) => {
    headers[k] = k.toLowerCase().includes("cookie") ? "***" : v;
  });
  await supabase.from("sd_grn_webhook_log").insert({
    event_type: eventType,
    item_count: items.length,
    auth_ok: true,
    headers,
    raw_body: body,
  });

  const rows = items.map(mapGrn).filter((r) => r && r.row_key);
  let upserted = 0;
  if (rows.length) {
    const { error } = await supabase
      .from("sd_grn_event")
      .upsert(rows as any[], { onConflict: "row_key" });
    if (error) {
      await supabase.from("sd_grn_webhook_log").insert({
        auth_ok: true,
        item_count: items.length,
        note: `upsert error: ${error.message}`,
        raw_body: body,
      });
    } else {
      upserted = rows.length;
    }
  }

  return json({ ok: true, auth_ok: true, logged: true, items: items.length, upserted });
});
