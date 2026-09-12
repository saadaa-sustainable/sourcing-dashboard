import 'server-only';
import { client, PAGE_SIZE } from './_shared';
import {
  computeInternalStatus,
  daysBetween,
  isTnaHighRisk,
  istToday,
  parseIsoDate,
} from '@/lib/business-logic';
import { loadMergedTnaRecords } from '@/lib/data';
import { loadProductCatalog } from './product';
import type { InwardPlanGroup, ReceivablePlanRow } from '../types';

export type ArrivalRow = {
  row_key: string;
  po_number: string | null;
  po_ref_num: string | null;
  product_code: string | null;
  product_variant: string | null;
  vendor_name: string | null;
  category: string | null;
  expected_qty: number | null;   // qty_expected_this_week (Receivable Plan)
  expected_date: string | null;  // delivery_date_this_week
  expected_week: string | null;  // ISO week of the expected date
  received_qty: number;          // Σ GRN received for this PO + product colour
  last_received_on: string | null;
  received_weeks: string | null; // distinct ISO weeks the goods actually landed
  variance: number | null;       // received − expected
  remarks: string | null;
  status: string | null;         // Receivable Plan input status
};

// SKU convention: <variant><_size> (e.g. SDVCTWH_XS → variant SDVCTWH).
const variantOfSku = (sku: string) => (sku.includes('_') ? sku.slice(0, sku.lastIndexOf('_')) : sku);

function isoWeekLabel(iso: string | null): string | null {
  if (!iso) return null;
  const d = new Date(`${iso.slice(0, 10)}T00:00:00Z`);
  if (Number.isNaN(d.getTime())) return null;
  const day = (d.getUTCDay() + 6) % 7; // Mon = 0
  d.setUTCDate(d.getUTCDate() - day + 3); // Thursday of this ISO week
  const firstThu = new Date(Date.UTC(d.getUTCFullYear(), 0, 4));
  const week = 1 + Math.round((d.getTime() - firstThu.getTime()) / 604_800_000);
  return `${d.getUTCFullYear()}-W${String(week).padStart(2, '0')}`;
}

/**
 * Arrivals — what the team said would arrive (Receivable Plan: qty_expected_this_week +
 * delivery_date_this_week) vs what actually landed (GRN Detail: received_quantity by
 * grn_created_at week), one row per PO + product colour. Read-only, company-wide.
 */
export async function loadArrivalPlan(): Promise<{ rows: ArrivalRow[] }> {
  const supabase = await client();

  // 1) Team expectations from the Receivable Plan inputs (qty + week).
  const inputs: Record<string, unknown>[] = [];
  for (let from = 0; ; from += PAGE_SIZE) {
    const { data } = await supabase
      .from('sd_receivable_input')
      .select('row_key, po_number, product_variant, delivery_date_this_week, qty_expected_this_week, remarks, status')
      .range(from, from + PAGE_SIZE - 1);
    if (!data?.length) break;
    inputs.push(...(data as Record<string, unknown>[]));
    if (data.length < PAGE_SIZE) break;
  }
  const filled = inputs.filter((i) => i.qty_expected_this_week != null || i.delivery_date_this_week != null);
  if (!filled.length) return { rows: [] };

  // 2) Plan base (product/vendor/ref) for those rows, by row_key.
  const rowKeys = [...new Set(filled.map((i) => String(i.row_key)).filter(Boolean))];
  const planByKey = new Map<string, Record<string, unknown>>();
  for (let i = 0; i < rowKeys.length; i += 200) {
    const chunk = rowKeys.slice(i, i + 200);
    if (!chunk.length) continue;
    const { data } = await supabase
      .from('sd_receivable_plan')
      .select('row_key, po_number, po_ref_num, product_code, product_variant, vendor_name')
      .in('row_key', chunk);
    for (const r of (data ?? []) as Record<string, unknown>[]) planByKey.set(String(r.row_key), r);
  }

  // 3) Actual receipts from GRN, aggregated by PO + product colour (variant).
  const poNos = [...new Set(
    filled.map((i) => String((planByKey.get(String(i.row_key))?.po_number ?? i.po_number) ?? '').trim()).filter(Boolean),
  )];
  const grnByKey = new Map<string, { qty: number; last: string | null; weeks: Set<string> }>();
  for (let i = 0; i < poNos.length; i += 200) {
    const chunk = poNos.slice(i, i + 200);
    if (!chunk.length) continue;
    const { data } = await supabase
      .from('sd_ee_grn')
      .select('po_number, sku, received_quantity, grn_created_at')
      .in('po_number', chunk);
    for (const g of (data ?? []) as { po_number: string; sku: string | null; received_quantity: number | null; grn_created_at: string | null }[]) {
      const key = `${g.po_number}|${variantOfSku(String(g.sku ?? ''))}`;
      const agg = grnByKey.get(key) ?? { qty: 0, last: null, weeks: new Set<string>() };
      agg.qty += Number(g.received_quantity) || 0;
      if (g.grn_created_at) {
        if (!agg.last || g.grn_created_at > agg.last) agg.last = g.grn_created_at;
        const wk = isoWeekLabel(g.grn_created_at);
        if (wk) agg.weeks.add(wk);
      }
      grnByKey.set(key, agg);
    }
  }

  // 4) Category from the product-master catalog.
  const catalog = await loadProductCatalog();
  const catByCode = new Map(catalog.map((c) => [c.product_code, c.category] as const));

  const rows: ArrivalRow[] = filled.map((i) => {
    const p = planByKey.get(String(i.row_key));
    const po_number = String((p?.po_number ?? i.po_number) ?? '') || null;
    const product_variant = String((p?.product_variant ?? i.product_variant) ?? '') || null;
    const product_code = (p?.product_code as string | null) ?? null;
    const grn = po_number && product_variant ? grnByKey.get(`${po_number}|${product_variant}`) : undefined;
    const expected_qty = (i.qty_expected_this_week as number | null) ?? null;
    const expected_date = (i.delivery_date_this_week as string | null) ?? null;
    const received_qty = grn?.qty ?? 0;
    return {
      row_key: String(i.row_key),
      po_number,
      po_ref_num: (p?.po_ref_num as string | null) ?? null,
      product_code,
      product_variant,
      vendor_name: (p?.vendor_name as string | null) ?? null,
      category: product_code ? catByCode.get(product_code) ?? null : null,
      expected_qty,
      expected_date,
      expected_week: isoWeekLabel(expected_date),
      received_qty,
      last_received_on: grn?.last ?? null,
      received_weeks: grn && grn.weeks.size ? [...grn.weeks].sort().join(', ') : null,
      variance: expected_qty != null ? received_qty - expected_qty : null,
      remarks: (i.remarks as string | null) ?? null,
      status: (i.status as string | null) ?? null,
    };
  });
  rows.sort(
    (a, b) => (a.expected_date ?? '').localeCompare(b.expected_date ?? '') || (a.po_number ?? '').localeCompare(b.po_number ?? ''),
  );
  return { rows };
}

/**
 * Receivable Plan — size-pivoted open-PO receivables + DOQ/stock/OOS, merged with
 * the weekly team inputs (delivery date / qty expected / remarks).
 */
export async function loadReceivablePlan(): Promise<ReceivablePlanRow[]> {
  const supabase = await client();
  const rows: Record<string, unknown>[] = [];
  for (let from = 0; ; from += PAGE_SIZE) {
    const { data, error } = await supabase
      .from('sd_receivable_plan')
      .select('*')
      .order('expected_delivery_date', { ascending: true, nullsFirst: false })
      .range(from, from + PAGE_SIZE - 1);
    if (error) throw new Error(`sd_receivable_plan: ${error.message}`);
    if (!data?.length) break;
    rows.push(...(data as Record<string, unknown>[]));
    if (data.length < PAGE_SIZE) break;
  }

  const { data: inputs } = await supabase
    .from('sd_receivable_input')
    .select('row_key, delivery_date_this_week, qty_expected_this_week, remarks, updated_at');
  const inputByKey = new Map(
    ((inputs ?? []) as Record<string, unknown>[]).map((i) => [String(i.row_key), i]),
  );

  // Live TNA/risk status per PO — planned dates from tna_tracker + form actuals,
  // keyed by PO ref (tna.po_no). Same source and rule as the Open PO Tracker.
  const tnaRecords = await loadMergedTnaRecords();
  const tnaByRef = new Map(
    tnaRecords.map((t) => [String(t.po_no ?? '').trim().toLowerCase(), t]),
  );
  const today = istToday();

  // Current stock split by size, from the inventory snapshot. Its SKUs are
  // <product_variant><size> (e.g. SDVCTWH + XS), so size = the SKU tail after
  // the variant prefix. Fetch only the variants present in the plan.
  const stockByVariant = await loadStockByVariantSize(
    supabase,
    [...new Set(rows.map((r) => String(r.product_variant ?? '')).filter(Boolean))],
  );

  return rows.map((r) => {
    const inp = inputByKey.get(String(r.row_key));
    const tna = tnaByRef.get(String(r.po_ref_num ?? '').trim().toLowerCase()) ?? null;
    const edd = parseIsoDate(r.expected_delivery_date as string | null);
    const delayDays = edd ? Math.max(0, daysBetween(today, edd)) : 0;
    const internal_status = computeInternalStatus({
      delayDays,
      highRisk: isTnaHighRisk(tna, today),
    });
    return {
      ...(r as unknown as ReceivablePlanRow),
      internal_status,
      stock_by_size: stockByVariant.get(String(r.product_variant ?? '')) ?? {},
      delivery_date_this_week: (inp?.delivery_date_this_week as string | null) ?? null,
      qty_expected_this_week: (inp?.qty_expected_this_week as number | null) ?? null,
      remarks: (inp?.remarks as string | null) ?? null,
      input_updated_at: (inp?.updated_at as string | null) ?? null,
    };
  });
}

const SIZE_LABEL_TO_KEY: Record<string, string> = {
  XS: 'size_xs', S: 'size_s', M: 'size_m', L: 'size_l', XL: 'size_xl',
  '2XL': 'size_2xl', '3XL': 'size_3xl', '4XL': 'size_4xl', '5XL': 'size_5xl',
};

async function loadStockByVariantSize(
  supabase: Awaited<ReturnType<typeof client>>,
  variants: string[],
): Promise<Map<string, Record<string, number>>> {
  const byVariant = new Map<string, Record<string, number>>();
  // Chunk the variant filter so each response stays under the row cap
  // (≤100 variants × ≤9 sizes < 1000 rows).
  for (let i = 0; i < variants.length; i += 100) {
    const chunk = variants.slice(i, i + 100);
    if (!chunk.length) continue;
    const { data } = await supabase
      .from('sd_inventory_planning')
      .select('sku, product_variant, current_stock')
      .in('product_variant', chunk);
    for (const iv of (data ?? []) as Record<string, unknown>[]) {
      const variant = String(iv.product_variant ?? '');
      const sku = String(iv.sku ?? '');
      const stock = Number(iv.current_stock) || 0;
      if (!variant || !stock || !sku.startsWith(variant)) continue;
      const key = SIZE_LABEL_TO_KEY[sku.slice(variant.length).toUpperCase()];
      if (!key) continue;
      const rec = byVariant.get(variant) ?? {};
      rec[key] = (rec[key] ?? 0) + stock;
      byVariant.set(variant, rec);
    }
  }
  return byVariant;
}

/**
 * Inward Plan — arriving stock from open (Approved) POs, grouped to colour level
 * (po_number × product_code × product_variant) off sd_po_lines_enriched.
 * Only lines with pending qty > 0 (still to arrive). Soonest EDD first.
 */
export async function loadInwardPlan(): Promise<InwardPlanGroup[]> {
  const supabase = await client();
  const rows: Record<string, unknown>[] = [];
  for (let from = 0; ; from += PAGE_SIZE) {
    const { data, error } = await supabase
      .from('sd_po_lines_enriched')
      .select(
        'po_number, po_ref_num, product_code, product_variant, vendor_code, vendor_name, pending_qty, original_qty, expected_delivery_date',
      )
      .eq('po_status_code', 3)
      .gt('pending_qty', 0)
      .range(from, from + PAGE_SIZE - 1);
    if (error) throw new Error(`sd_po_lines_enriched: ${error.message}`);
    if (!data?.length) break;
    rows.push(...(data as Record<string, unknown>[]));
    if (data.length < PAGE_SIZE) break;
  }

  const groups = new Map<string, InwardPlanGroup>();
  for (const r of rows) {
    const po_number = String(r.po_number ?? '');
    const product_code = String(r.product_code ?? '');
    const product_variant = String(r.product_variant ?? '');
    const arriving = Number(r.pending_qty) || 0;
    const ordered = Number(r.original_qty) || 0;
    const edd = (r.expected_delivery_date as string | null) ?? null;
    const k = `${po_number}${product_code}${product_variant}`;
    const g = groups.get(k);
    if (g) {
      g.arriving_qty += arriving;
      g.ordered_qty += ordered;
      if (edd && (!g.expected_delivery_date || edd < g.expected_delivery_date)) {
        g.expected_delivery_date = edd;
      }
    } else {
      groups.set(k, {
        po_number,
        po_ref_num: (r.po_ref_num as string | null) ?? null,
        product_code,
        product_variant,
        vendor_code: String(r.vendor_code ?? ''),
        vendor_name: String(r.vendor_name ?? ''),
        ordered_qty: ordered,
        arriving_qty: arriving,
        expected_delivery_date: edd,
      });
    }
  }

  return [...groups.values()].sort((a, b) => {
    if (!a.expected_delivery_date) return 1;
    if (!b.expected_delivery_date) return -1;
    return a.expected_delivery_date.localeCompare(b.expected_delivery_date);
  });
}
