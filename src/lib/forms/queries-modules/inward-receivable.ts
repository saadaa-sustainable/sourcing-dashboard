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
import type {
  InwardPlanEntry,
  ProductCatalogItem,
  InwardPlanGroup,
  ReceivablePlanRow,
} from '../types';

/**
 * Inward Plan II — the team-filled monthly inward sheet (Buying Plan tab).
 * Returns the month's rows plus the product-master catalog (same source as the
 * Buying Plan's Add-Product picker) so the team types a code straight from the
 * master rather than from the plan.
 */
export async function loadInwardPlanSheet(planMonth: string): Promise<{
  entries: InwardPlanEntry[];
  catalog: ProductCatalogItem[];
}> {
  const supabase = await client();
  const [{ data: entries, error }, catalog] = await Promise.all([
    supabase
      .from('sd_inward_plan_entry')
      .select('*')
      .eq('plan_month', planMonth)
      .order('id'),
    loadProductCatalog(),
  ]);
  if (error) throw new Error(`sd_inward_plan_entry: ${error.message}`);
  const enriched = await enrichInwardWithPoDates((entries ?? []) as InwardPlanEntry[]);
  return { entries: enriched, catalog };
}

/**
 * Item 4: fill each inward entry's EDD + closure date from the PO's own feeds
 * (never re-entered). EDD comes from whichever feed holds the PO (open or
 * completed); the closure date only exists once the PO has completed.
 */
async function enrichInwardWithPoDates(rows: InwardPlanEntry[]): Promise<InwardPlanEntry[]> {
  if (!rows.length) return rows;
  const supabase = await client();
  const poNos = [...new Set(rows.map((e) => (e.po_no ?? '').trim()).filter(Boolean))];
  const poDates = new Map<string, { edd: string | null; closure: string | null }>();
  if (poNos.length) {
    const [openPo, compPo] = await Promise.all([
      supabase.from('pending_po_master').select('po_number, expected_delivery_date').in('po_number', poNos),
      supabase.from('sd_po_completed').select('po_number, expected_delivery_date, po_updated_date').in('po_number', poNos),
    ]);
    for (const r of (openPo.data ?? []) as { po_number: string; expected_delivery_date: string | null }[]) {
      const cur = poDates.get(r.po_number) ?? { edd: null, closure: null };
      cur.edd = cur.edd ?? r.expected_delivery_date ?? null;
      poDates.set(r.po_number, cur);
    }
    // Completed feed wins for EDD (final) and is the only source of a closure date.
    for (const r of (compPo.data ?? []) as {
      po_number: string; expected_delivery_date: string | null; po_updated_date: string | null;
    }[]) {
      const cur = poDates.get(r.po_number) ?? { edd: null, closure: null };
      cur.edd = r.expected_delivery_date ?? cur.edd;
      cur.closure = r.po_updated_date ?? cur.closure;
      poDates.set(r.po_number, cur);
    }
  }
  return rows.map((e) => {
    const d = e.po_no ? poDates.get(e.po_no.trim()) : undefined;
    return { ...e, expected_delivery_date: d?.edd ?? null, po_closure_date: d?.closure ?? null };
  });
}

/**
 * Item 5: company-wide "what's arriving when". The monthly approved inward plan
 * across recent + upcoming months (sd_inward_plan_entry), enriched with each PO's
 * EDD + closure (item 4) and the product's category, for a read-only, filterable
 * cross-department view. Planned = inward_qty, actual = actual_inward_qty.
 */
export async function loadArrivalPlan(): Promise<{
  rows: (InwardPlanEntry & { category: string | null })[];
}> {
  const supabase = await client();
  const [{ data: entries }, catalog] = await Promise.all([
    supabase
      .from('sd_inward_plan_entry')
      .select('*')
      .order('plan_month', { ascending: false })
      .limit(PAGE_SIZE),
    loadProductCatalog(),
  ]);
  const enriched = await enrichInwardWithPoDates((entries ?? []) as InwardPlanEntry[]);
  const catByCode = new Map(catalog.map((c) => [c.product_code, c.category] as const));
  const rows = enriched.map((e) => ({
    ...e,
    category: catByCode.get(e.product_code) ?? null,
  }));
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
