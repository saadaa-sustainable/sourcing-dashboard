import 'server-only';
import { createClient as createSupabaseClient } from '@supabase/supabase-js';
import { pageAll } from '@/lib/forms/queries-modules/_shared';

/**
 * NPD Tracker V7 (its own Supabase project) — the only source of new, not-yet-in-EasyEcom
 * products for Standard Cost (user, 2026-10-09). Read server-side with the NPD project's
 * service key: NPD_SUPABASE_URL + NPD_SUPABASE_SERVICE_ROLE (Vercel env, never sent to the browser).
 *
 * Eligible = live (not deleted) and not LAUNCHED. The product code is the NPD SKU code, so a
 * row can only be added when that code is one clean code, unique on the tracker, and not already
 * on Standard Cost or in EasyEcom; otherwise it is listed with the reason it cannot be added.
 */

export type NpdProduct = {
  id: number;
  sku_code: string;
  product_name: string | null;
  item_code: string | null;
  category: string | null;
  status: string | null;
  product_type: string | null;
  launch: string | null;
};

export type NpdOption = NpdProduct & {
  /** The product code it would get (upper-cased SKU code), or null when the SKU code is unusable. */
  code: string | null;
  /** Why it cannot be added; null = can be added. */
  blocked: string | null;
};

const CODE_RE = /^[A-Z0-9]{3,30}$/;

export class NpdNotConfiguredError extends Error {}

function npdClient() {
  const url = process.env.NPD_SUPABASE_URL;
  const key = process.env.NPD_SUPABASE_SERVICE_ROLE;
  if (!url || !key) {
    throw new NpdNotConfiguredError(
      'NPD Tracker V7 is not connected: add NPD_SUPABASE_URL and NPD_SUPABASE_SERVICE_ROLE to the dashboard’s environment.',
    );
  }
  return createSupabaseClient(url, key, { auth: { persistSession: false, autoRefreshToken: false } });
}

const SELECT = 'id, sku_code, product_name, item_code, category, status, product, launch_month, launch_year, deleted_at';

type Raw = {
  id: number;
  sku_code: string | null;
  product_name: string | null;
  item_code: string | null;
  category: string | null;
  status: string | null;
  product: string | null;
  launch_month: string | null;
  launch_year: string | null;
  deleted_at: string | null;
};

const clean = (v: string | null) => (v ?? '').trim() || null;

function shape(r: Raw): NpdProduct {
  const launch = [clean(r.launch_month), clean(r.launch_year)].filter(Boolean).join(' ') || null;
  return {
    id: Number(r.id),
    sku_code: (r.sku_code ?? '').trim(),
    product_name: clean(r.product_name),
    item_code: clean(r.item_code),
    category: clean(r.category),
    status: clean(r.status),
    product_type: clean(r.product),
    launch,
  };
}

const launched = (status: string | null) => (status ?? '').trim().toUpperCase() === 'LAUNCHED';

/** Every live, not-launched NPD product. */
async function loadEligibleRows(): Promise<NpdProduct[]> {
  const db = npdClient();
  const rows = await pageAll<Raw>(() => db.from('products').select(SELECT).is('deleted_at', null).order('id'));
  return rows.map(shape).filter((p) => !launched(p.status));
}

/**
 * The picker list for Standard Cost's "From NPD Tracker V7": each eligible NPD product with the
 * code it would get, or why it cannot be added.
 * `onSheet` = codes already on Standard Cost (any track, upper-cased); `inEasyEcom` = catalog codes;
 * `npdRegistered` = NPD row ids already registered as products.
 */
export async function loadNpdOptions(ctx: {
  onSheet: Set<string>;
  inEasyEcom: Set<string>;
  npdRegistered: Set<number>;
}): Promise<NpdOption[]> {
  const rows = await loadEligibleRows();
  const codeCount = new Map<string, number>();
  for (const r of rows) {
    const c = r.sku_code.toUpperCase();
    if (CODE_RE.test(c)) codeCount.set(c, (codeCount.get(c) ?? 0) + 1);
  }
  return rows
    .map((r): NpdOption => {
      const c = r.sku_code.toUpperCase();
      let blocked: string | null = null;
      if (!r.sku_code) blocked = 'No SKU code on NPD Tracker V7';
      else if (!CODE_RE.test(c)) blocked = 'SKU code is not one product code (it holds several codes, spaces or symbols) — fix it on NPD Tracker V7';
      else if ((codeCount.get(c) ?? 0) > 1) blocked = `SKU code ${c} is used by ${codeCount.get(c)} NPD products — fix it on NPD Tracker V7`;
      else if (ctx.npdRegistered.has(r.id)) blocked = 'Already on Standard Cost';
      else if (ctx.onSheet.has(c)) blocked = `${c} is already on Standard Cost`;
      else if (ctx.inEasyEcom.has(c)) blocked = `${c} is already in EasyEcom — add it From Product Master`;
      return { ...r, code: CODE_RE.test(c) ? c : null, blocked };
    })
    .sort((a, b) => Number(Boolean(a.blocked)) - Number(Boolean(b.blocked)) || (a.code ?? a.sku_code).localeCompare(b.code ?? b.sku_code));
}

/** One NPD product, re-read on the server when it is added (never trust the browser's copy). */
export async function loadNpdProduct(id: number): Promise<{ row: NpdProduct; duplicates: number } | null> {
  const rows = await loadEligibleRows();
  const row = rows.find((r) => r.id === id);
  if (!row) return null;
  const c = row.sku_code.toUpperCase();
  const duplicates = rows.filter((r) => r.sku_code.toUpperCase() === c).length;
  return { row, duplicates };
}
