import 'server-only';
import { createClient as createSupabaseClient } from '@supabase/supabase-js';
import { pageAll } from '@/lib/forms/queries-modules/_shared';

/**
 * NPD Tracker V7 (its own Supabase project) — the only source of new, not-yet-in-EasyEcom
 * products for Standard Cost (user, 2026-10-09). Read server-side with the NPD project's
 * service key: NPD_SUPABASE_URL + NPD_SUPABASE_SERVICE_ROLE (Vercel env, never sent to the browser).
 *
 * Eligible = live (not deleted) and not LAUNCHED. The product code is the NPD ITEM CODE
 * (upper-cased, e.g. K-WBW-SC-011-V1), so a row can only be added when it has one, unique on the
 * tracker, and not already on Standard Cost or in EasyEcom; otherwise it is listed with the reason
 * it cannot be added. The SKU code travels with it for PO Approval (SKU quantities).
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
  /** The product code it would get (upper-cased item code), or null when the item code is unusable. */
  code: string | null;
  /** Why it cannot be added; null = can be added. */
  blocked: string | null;
};

const CODE_RE = /^[A-Z0-9][A-Z0-9-]{2,39}$/;

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
    const c = (r.item_code ?? '').toUpperCase();
    if (CODE_RE.test(c)) codeCount.set(c, (codeCount.get(c) ?? 0) + 1);
  }
  return rows
    .map((r): NpdOption => {
      const c = (r.item_code ?? '').toUpperCase();
      let blocked: string | null = null;
      if (!r.item_code) blocked = 'No item code on NPD Tracker V7 yet';
      else if (!CODE_RE.test(c)) blocked = 'Item code is not one code (spaces or symbols) — fix it on NPD Tracker V7';
      else if ((codeCount.get(c) ?? 0) > 1) blocked = `Item code ${c} is used by ${codeCount.get(c)} NPD products — fix it on NPD Tracker V7`;
      else if (ctx.npdRegistered.has(r.id)) blocked = 'Already on Standard Cost';
      else if (ctx.onSheet.has(c)) blocked = `${c} is already on Standard Cost`;
      else if (ctx.inEasyEcom.has(c)) blocked = `${c} is already in EasyEcom — add it From Product Master`;
      return { ...r, code: CODE_RE.test(c) ? c : null, blocked };
    })
    .sort((a, b) => Number(Boolean(a.blocked)) - Number(Boolean(b.blocked)) || (a.code ?? a.item_code ?? '').localeCompare(b.code ?? b.item_code ?? ''));
}

/** One NPD product, re-read on the server when it is added (never trust the browser's copy). */
export async function loadNpdProduct(id: number): Promise<{ row: NpdProduct; duplicates: number } | null> {
  const rows = await loadEligibleRows();
  const row = rows.find((r) => r.id === id);
  if (!row) return null;
  const c = (row.item_code ?? '').toUpperCase();
  const duplicates = c ? rows.filter((r) => (r.item_code ?? '').toUpperCase() === c).length : 0;
  return { row, duplicates };
}

/**
 * What PO Approval's SKU grid needs from NPD for a product added from the tracker: its SKU-code
 * cell (colour codes), sizes and colour names. Read live so a fix made on the tracker shows up.
 * Null when NPD is not connected or the row is gone.
 */
export async function loadNpdSkuSource(
  npdId: number,
): Promise<{ sku_code: string | null; sizes: string | null; colors_by_code: string | null } | null> {
  try {
    const db = npdClient();
    const { data } = await db.from('products').select('sku_code, sizes, colors_by_code').eq('id', npdId).maybeSingle();
    return (data as { sku_code: string | null; sizes: string | null; colors_by_code: string | null } | null) ?? null;
  } catch {
    return null;
  }
}

/** One row of Master → NPD Products: an NPD Tracker V7 product and where it stands here. */
export type NpdMasterRow = NpdProduct & {
  /** The product code it has (added) or would get (upper-cased item code). */
  code: string | null;
  /** Added = on Standard Cost through "From NPD Tracker V7"; linked = since linked to its EasyEcom code. */
  stage: 'added' | 'linked' | 'can_add' | 'blocked' | 'launched';
  /** Plain words for the stage (the blocked reason, who added it, the EasyEcom code). */
  note: string;
  added_by: string | null;
  added_at: string | null;
  linked_to: string | null;
};

/**
 * Every live NPD Tracker V7 product (launched ones included, for the record) with where it stands
 * on the dashboard. `registered` = sd_temp_product rows with source 'npd', by NPD id.
 */
export async function loadNpdMaster(ctx: {
  registered: Map<number, { code: string; status: string; merged_into: string | null; created_by: string | null; created_at: string | null }>;
  onSheet: Set<string>;
  inEasyEcom: Set<string>;
}): Promise<NpdMasterRow[]> {
  const db = npdClient();
  const all = (await pageAll<Raw>(() => db.from('products').select(SELECT).is('deleted_at', null).order('id'))).map(shape);
  const live = all.filter((r) => !launched(r.status));
  const codeCount = new Map<string, number>();
  for (const r of live) {
    const c = (r.item_code ?? '').toUpperCase();
    if (CODE_RE.test(c)) codeCount.set(c, (codeCount.get(c) ?? 0) + 1);
  }
  const ORDER: Record<NpdMasterRow['stage'], number> = { added: 0, linked: 1, can_add: 2, blocked: 3, launched: 4 };
  const rows = all.map((r): NpdMasterRow => {
    const c = (r.item_code ?? '').toUpperCase();
    const reg = ctx.registered.get(r.id);
    const base = { ...r, added_by: reg?.created_by ?? null, added_at: reg?.created_at ?? null, linked_to: reg?.merged_into ?? null };
    if (reg && reg.status === 'merged') {
      return { ...base, code: reg.code, stage: 'linked', note: `Linked to EasyEcom product ${reg.merged_into ?? ''}`.trim() };
    }
    if (reg) return { ...base, code: reg.code, stage: 'added', note: 'On Standard Cost' };
    if (launched(r.status)) return { ...base, code: CODE_RE.test(c) ? c : null, stage: 'launched', note: 'Launched — add it From Product Master' };
    let blocked: string | null = null;
    if (!r.item_code) blocked = 'No item code on NPD Tracker V7 yet';
    else if (!CODE_RE.test(c)) blocked = 'Item code is not one code — fix it on NPD Tracker V7';
    else if ((codeCount.get(c) ?? 0) > 1) blocked = `Item code used by ${codeCount.get(c)} NPD products — fix it on NPD Tracker V7`;
    else if (ctx.onSheet.has(c)) blocked = `${c} is already on Standard Cost`;
    else if (ctx.inEasyEcom.has(c)) blocked = `${c} is already in EasyEcom — add it From Product Master`;
    return { ...base, code: CODE_RE.test(c) ? c : null, stage: blocked ? 'blocked' : 'can_add', note: blocked ?? 'Can be added on Standard Cost' };
  });
  // What needs attention first: on Standard Cost, can be added, blocked; launched ones last.
  return rows.sort((a, b) => ORDER[a.stage] - ORDER[b.stage] || (a.code ?? a.item_code ?? '').localeCompare(b.code ?? b.item_code ?? ''));
}
