import 'server-only';
import { client, pageAll, PAGE_SIZE } from './_shared';
import { buildVendorRollups, buildTrackerRows, capacityRulesFrom } from '@/lib/business-logic';
import { loadAnalyticsRules } from './analytics';
import { loadDashboardData } from '@/lib/data';
import type { DashboardData } from '@/lib/types';
import type {
  EeVendorMasterRow,
  VendorOtifRow,
  VendorProductAllocation,
  VendorCapacityLog,
  VendorTypeMultiplier,
} from '../types';

/**
 * Vendor master — the RAW EasyEcom vendor table (sd_ee_vendor_master), mirroring
 * BigQuery `Easyecom_Saadaa_vendors` exactly. Every EasyEcom vendor field, no
 * Google-Sheet enrichment. Read-only. (The Airbyte ingestion columns —
 * _airbyte_*, the pk id — are intentionally not selected.)
 */
/* ------------------------------------------------------------------ */
/* Spec 7.8 — one vendor's history, PO by PO                           */
/* ------------------------------------------------------------------ */

export type VendorPoHistoryRow = {
  /** The EasyEcom reference, which is what people call a PO. */
  poRef: string;
  poNumber: string | null;
  /** The product codes on that PO — usually one. */
  products: string[];
  qty: number;
  value: number;
  /** Raised (earliest line date) and completed (latest update). */
  start: string;
  done: string;
  /** Days the vendor actually took, start to completion. */
  days: number;
  /** What it was expected by, and how late it finished (negative = early). */
  edd: string | null;
  lateDays: number | null;
};

export type VendorPoHistory = {
  vendorCode: string;
  vendorName: string | null;
  /** Completed POs, newest first. */
  rows: VendorPoHistoryRow[];
  /** Spec 7.8: the average is across ALL of this vendor's completed POs. */
  averageDays: number | null;
  totalPos: number;
  /** Spec 7.8: "last PO" means this vendor's most recent one for THIS product. */
  productCode: string | null;
  lastSameProduct: VendorPoHistoryRow | null;
  /** Their most recent PO of anything, for when there is no history of this product. */
  lastAny: VendorPoHistoryRow | null;
  /** Share of POs that finished on or before their expected delivery date. */
  onTimePct: number | null;
};

/**
 * What this vendor has actually done, PO by PO: how long each one took, by PO number.
 *
 * The two headline figures answer different questions and the spec is precise about which
 * is which — the LAST PO is the one for the same product (the closest thing to "what will
 * this one take"), while the AVERAGE is across everything they have made for us (what they
 * take in general). Both come from completed POs only: an open PO has no duration yet.
 */
export async function loadVendorPoHistory(
  vendorCodeRaw: string | null | undefined,
  productCodeRaw?: string | null,
): Promise<VendorPoHistory | null> {
  const vendorCode = (vendorCodeRaw ?? '').trim();
  if (!vendorCode) return null;
  const productCode = (productCodeRaw ?? '').trim().toUpperCase();
  const supabase = await client();

  type Line = {
    po_ref_num: string | null;
    po_number: string | null;
    product_code: string | null;
    vendor_name: string | null;
    original_qty: number | null;
    total_po_value: number | null;
    po_date: string | null;
    po_updated_date: string | null;
    expected_delivery_date: string | null;
  };
  // Every completed line for the vendor — a busy vendor runs well past 1,000 lines.
  const lines = await pageAll<Line>(() =>
    supabase
      .from('sd_po_completed')
      .select(
        'po_ref_num, po_number, product_code, vendor_name, original_qty, total_po_value, po_date, po_updated_date, expected_delivery_date',
      )
      .ilike('vendor_code', vendorCode)
      .not('po_date', 'is', null)
      .not('po_updated_date', 'is', null)
      .order('po_detail_id'),
  );

  // A PO is its lines: it starts on the earliest line date and is done on the latest update.
  const byPo = new Map<string, VendorPoHistoryRow & { productSet: Set<string> }>();
  let vendorName: string | null = null;
  for (const l of lines) {
    const ref = (l.po_ref_num ?? '').trim();
    if (!ref || !l.po_date || !l.po_updated_date) continue;
    vendorName ??= l.vendor_name;
    const cur = byPo.get(ref);
    if (!cur) {
      byPo.set(ref, {
        poRef: ref,
        poNumber: (l.po_number ?? '').trim() || null,
        products: [],
        productSet: new Set(l.product_code ? [l.product_code.trim().toUpperCase()] : []),
        qty: Number(l.original_qty) || 0,
        value: Number(l.total_po_value) || 0,
        start: l.po_date,
        done: l.po_updated_date,
        days: 0,
        edd: l.expected_delivery_date,
        lateDays: null,
      });
    } else {
      if (l.product_code) cur.productSet.add(l.product_code.trim().toUpperCase());
      cur.qty += Number(l.original_qty) || 0;
      cur.value += Number(l.total_po_value) || 0;
      if (l.po_date < cur.start) cur.start = l.po_date;
      if (l.po_updated_date > cur.done) cur.done = l.po_updated_date;
      // The PO is late against its LAST promised date.
      if (l.expected_delivery_date && (!cur.edd || l.expected_delivery_date > cur.edd)) {
        cur.edd = l.expected_delivery_date;
      }
    }
  }

  const days = (from: string, to: string) => Math.round((Date.parse(to) - Date.parse(from)) / 86_400_000);
  const rows: VendorPoHistoryRow[] = [...byPo.values()]
    .map(({ productSet, ...r }) => ({
      ...r,
      products: [...productSet].sort(),
      days: Math.max(0, days(r.start, r.done)),
      lateDays: r.edd ? days(r.edd, r.done) : null,
    }))
    .sort((a, b) => b.done.localeCompare(a.done));

  const averageDays = rows.length
    ? Math.round((rows.reduce((s, r) => s + r.days, 0) / rows.length) * 10) / 10
    : null;
  const rated = rows.filter((r) => r.lateDays != null);
  const onTimePct = rated.length
    ? Math.round((rated.filter((r) => (r.lateDays as number) <= 0).length / rated.length) * 100)
    : null;

  return {
    vendorCode: vendorCode.toUpperCase(),
    vendorName,
    rows,
    averageDays,
    totalPos: rows.length,
    productCode: productCode || null,
    lastSameProduct: productCode ? rows.find((r) => r.products.includes(productCode)) ?? null : null,
    lastAny: rows[0] ?? null,
    onTimePct,
  };
}

export async function loadVendorMaster(): Promise<EeVendorMasterRow[]> {
  const supabase = await client();
  const { data, error } = await supabase
    .from('sd_ee_vendor_master')
    .select(
      'vendor_code, vendor_name, active, email, address, paymentterm, deliveryterm, currency_code, vendor_c_id, ' +
        'firstname, lastname, contact_number, pan, tax_identification_number, msme_number, unregistered_vendor, ' +
        'vendor_token, api_token, dl_number, dl_expiry, fssai_number, fssai_expiry, freight_forwarding_days, ' +
        'prep_days, shipment_intransit_days, warehouse_checkin_time, synced_at',
    )
    .order('vendor_name');
  if (error) throw new Error(`sd_ee_vendor_master: ${error.message}`);
  return (data ?? []) as unknown as EeVendorMasterRow[];
}

/**
 * Per-vendor OTIF scorecard (item 2) — On-Time + In-Full + joint OTIF from
 * sd_vendor_otif(). On-Time uses the vendor commitment log where present, else
 * the historical PO EDD; it becomes fully meaningful as the log accumulates.
 */
export async function loadVendorOtif(
  windowDays = 180,
  dashboard?: DashboardData,
): Promise<{ windowDays: number; vendors: VendorOtifRow[] }> {
  const supabase = await client();
  const vkey = (code: string | null | undefined, name: string | null | undefined) =>
    code && code.trim() ? code.trim().toUpperCase() : (name ?? '').trim().toUpperCase();

  const [{ data }, dash] = await Promise.all([
    supabase.rpc('sd_vendor_otif', { p_window_days: windowDays }),
    dashboard ?? loadDashboardData(),
  ]);

  // Critical Path (3rd TNA variable) — on-track % of each vendor's OPEN POs,
  // from the same tracker/high-risk logic the Open PO Tracker uses.
  const tracker = buildTrackerRows(dash.pendingPos, dash.vendorTypes, dash.vendorMasters, dash.tnaRecords);
  const cp = new Map<string, { open: number; onTrack: number }>();
  for (const r of tracker) {
    const k = vkey(r.vendorCode, r.vendorName);
    if (!k) continue;
    const c = cp.get(k) ?? { open: 0, onTrack: 0 };
    c.open += 1;
    if (r.internalStatus === 'On Track') c.onTrack += 1;
    cp.set(k, c);
  }

  const vendors: VendorOtifRow[] = ((data ?? []) as Array<{
    vendor_code: string | null; vendor_name: string | null;
    pos: number | null; dated_pos?: number | null; on_time_pos: number | null; in_full_pos: number | null; otif_pos: number | null;
    on_time_pct: number | null; fill_pct: number | null; otif_pct: number | null;
  }>).map((r) => {
    const c = cp.get(vkey(r.vendor_code, r.vendor_name));
    return {
      vendorCode: r.vendor_code,
      vendorName: r.vendor_name ?? '—',
      pos: Number(r.pos) || 0,
      datedPos: Number(r.dated_pos ?? r.pos) || 0,
      onTimePos: Number(r.on_time_pos) || 0,
      inFullPos: Number(r.in_full_pos) || 0,
      otifPos: Number(r.otif_pos) || 0,
      onTimePct: Number(r.on_time_pct) || 0,
      fillPct: Number(r.fill_pct) || 0,
      otifPct: Number(r.otif_pct) || 0,
      openPos: c?.open ?? 0,
      criticalPathPct: c && c.open > 0 ? Math.round((c.onTrack / c.open) * 100) : null,
    };
  });
  return { windowDays, vendors };
}

/**
 * In-process (Approved) quantity per vendor, from the PO pipeline view
 * (sd_vendor_in_process). Feeds Vendor Capacity's available-capacity — real PO
 * load instead of the sheet's open-qty. Keyed by lower-cased vendor_code.
 */
export async function loadInProcessByVendor(): Promise<Map<string, number>> {
  const supabase = await client();
  const { data } = await supabase
    .from('sd_vendor_in_process')
    .select('vendor_code, in_process_qty');

  const map = new Map<string, number>();
  (
    (data ?? []) as { vendor_code: string | null; in_process_qty: number | null }[]
  ).forEach((row) => {
    const code = (row.vendor_code ?? '').trim().toLowerCase();
    if (code) map.set(code, Number(row.in_process_qty) || 0);
  });
  return map;
}

/**
 * Each vendor's most recently logged monthly capacity (sd_vendor_capacity_log),
 * so the PO approval card can show "last-updated capacity". Keyed lower-case.
 */
export async function loadLatestVendorCapacity(): Promise<
  Map<string, { capacityPerMonth: number; weekOf: string | null; machines: number; karigar: number }>
> {
  const supabase = await client();
  const { data } = await supabase
    .from('sd_vendor_capacity_log')
    .select('vendor_code, capacity_per_month, week_of, entry_date, machines_allocated, active_karigar')
    .order('entry_date', { ascending: false });

  const map = new Map<string, { capacityPerMonth: number; weekOf: string | null; machines: number; karigar: number }>();
  (
    (data ?? []) as {
      vendor_code: string | null;
      capacity_per_month: number | null;
      week_of: string | null;
      entry_date: string | null;
      machines_allocated: number | null;
      active_karigar: number | null;
    }[]
  ).forEach((row) => {
    const code = (row.vendor_code ?? '').trim().toLowerCase();
    // Rows arrive newest-first, so the first one seen per vendor is the latest. The two
    // inputs travel too, so the approval card can run the one capacity model for the
    // PO's own type instead of trusting a stored monthly figure.
    if (code && !map.has(code)) {
      map.set(code, {
        capacityPerMonth: Number(row.capacity_per_month) || 0,
        weekOf: row.entry_date ?? row.week_of ?? null,
        machines: Number(row.machines_allocated) || 0,
        karigar: Number(row.active_karigar) || 0,
      });
    }
  });
  return map;
}

/* ------------------------------------------------------------------ */
/* Vendor capacity                                                     */
/* ------------------------------------------------------------------ */

/** Vendor Capacity item 1 — all per-vendor per-product capacity allocations. */
export async function loadVendorProductAllocations(): Promise<VendorProductAllocation[]> {
  const supabase = await client();
  const { data } = await supabase
    .from('sd_vendor_product_capacity_allocation')
    .select('id, vendor_code, product_code, allocated_qty, entry_date, entered_by')
    .order('vendor_code')
    .order('product_code')
    .limit(PAGE_SIZE);
  return (data ?? []) as VendorProductAllocation[];
}

export async function loadVendorCapacity(dashboard?: DashboardData) {
  const supabase = await client();

  // One live row per vendor — no week bucketing. entry_date carries when it was
  // last updated, which drives the staleness flag on the screen.
  const { data: logs } = await supabase
    .from('sd_vendor_capacity_log')
    .select('*')
    .order('vendor_code');

  const { data: multipliers } = await supabase
    .from('sd_vendor_type_multiplier')
    .select('*');

  const [dash, rules] = await Promise.all([dashboard ?? loadDashboardData(), loadAnalyticsRules()]);
  // The sheet's live inputs feed the one capacity model, with the Rules Master values.
  const capacityByVendor = new Map(
    ((logs ?? []) as VendorCapacityLog[]).map((l) => [
      (l.vendor_code ?? '').trim().toLowerCase(),
      { machines: Number(l.machines_allocated) || 0, karigar: Number(l.active_karigar) || 0 },
    ]),
  );
  const rollups = buildVendorRollups(
    dash.pendingPos,
    dash.vendorTypes,
    dash.vendorMasters,
    dash.tnaRecords,
    undefined,
    capacityByVendor,
    capacityRulesFrom(rules),
  );

  return {
    logs: (logs ?? []) as VendorCapacityLog[],
    multipliers: (multipliers ?? []) as VendorTypeMultiplier[],
    rollups,
    vendorMasters: dash.vendorMasters,
    vendorTypes: dash.vendorTypes,
  };
}
