// EasyCom Inventory webhook receiver — capture-first.
//
// On every call it logs the raw payload to sd_inventory_webhook_log (so you can
// SEE EasyCom's real JSON before locking the mapping), then best-effort upserts
// SKU stock into sd_inventory. The field mapping in mapItem() is a best guess
// until the real payload is seen — the whole item is archived in `raw` either way.
//
// Deploy:  supabase functions deploy easyecom-inventory --no-verify-jwt
// Secret:  supabase secrets set EASYECOM_WEBHOOK_TOKEN=<token>
//   (SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are injected automatically.)

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_ROLE = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const WEBHOOK_TOKEN = Deno.env.get("EASYECOM_WEBHOOK_TOKEN") ?? "";

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

// Pull the items array out of whatever shape EasyCom sends.
function extractItems(body: any): any[] {
  if (Array.isArray(body)) return body;
  for (const key of ["items", "inventory", "data", "products", "skus", "payload"]) {
    if (Array.isArray(body?.[key])) return body[key];
  }
  if (body && (body.sku || body.SKU || body.sku_code)) return [body]; // single item
  return [];
}

// Best-guess field mapping — finalised once EasyCom's real field names are seen.
function mapItem(it: any) {
  const sku = str(it.sku ?? it.SKU ?? it.sku_code ?? it.product_sku ?? it.skuCode);
  if (!sku) return null;
  return {
    sku,
    warehouse:
      str(it.warehouse ?? it.warehouse_name ?? it.location ?? it.wh ?? "") ?? "",
    product_id: str(it.product_id ?? it.productId ?? it.cp_id ?? it.id),
    available_quantity: num(
      it.available_quantity ?? it.availableQuantity ?? it.available ??
        it.quantity ?? it.stock ?? it.inventory,
    ),
    total_quantity: num(
      it.total_quantity ?? it.totalQuantity ?? it.total ?? it.total_stock,
    ),
    reserved_quantity: num(
      it.reserved_quantity ?? it.reservedQuantity ?? it.reserved ??
        it.blocked_quantity,
    ),
    received_at: new Date().toISOString(),
    raw: it,
  };
}

Deno.serve(async (req: Request) => {
  if (req.method !== "POST") return json({ ok: false, error: "POST only" }, 405);

  const url = new URL(req.url);
  const rawText = await req.text();
  let body: any = null;
  try {
    body = rawText ? JSON.parse(rawText) : null;
  } catch {
    body = { _unparsed: rawText };
  }

  const token = extractToken(req, url, body);
  const authOk = WEBHOOK_TOKEN.length > 0 && token === WEBHOOK_TOKEN;
  const items = extractItems(body);

  const headers: Record<string, string> = {};
  req.headers.forEach((v, k) => {
    headers[k] = k.toLowerCase().includes("cookie") ? "***" : v;
  });

  // Always capture — even on bad auth — so nothing is lost.
  await supabase.from("sd_inventory_webhook_log").insert({
    trigger_type: str(
      body?.trigger_type ?? body?.trigger ?? body?.event ??
        url.searchParams.get("trigger"),
    ),
    marketplace: str(
      body?.marketplace ?? body?.channel ?? body?.marketplace_name,
    ),
    item_count: items.length,
    auth_ok: authOk,
    headers,
    raw_body: body,
  });

  if (!authOk) return json({ ok: true, auth_ok: false, logged: true });

  const rows = items.map(mapItem).filter(Boolean);
  let upserted = 0;
  if (rows.length) {
    const { error } = await supabase
      .from("sd_inventory")
      .upsert(rows as any[], { onConflict: "sku,warehouse" });
    if (error) {
      await supabase.from("sd_inventory_webhook_log").insert({
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
