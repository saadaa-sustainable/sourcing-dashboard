import 'server-only';
import { client, PAGE_SIZE } from './_shared';
import { buildVendorRollups, buildTrackerRows } from '@/lib/business-logic';
import { loadDashboardData } from '@/lib/data';
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
): Promise<{ windowDays: number; vendors: VendorOtifRow[] }> {
  const supabase = await client();
  const vkey = (code: string | null | undefined, name: string | null | undefined) =>
    code && code.trim() ? code.trim().toUpperCase() : (name ?? '').trim().toUpperCase();

  const [{ data }, dash] = await Promise.all([
    supabase.rpc('sd_vendor_otif', { p_window_days: windowDays }),
    loadDashboardData(),
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
    pos: number | null; on_time_pos: number | null; in_full_pos: number | null; otif_pos: number | null;
    on_time_pct: number | null; fill_pct: number | null; otif_pct: number | null;
  }>).map((r) => {
    const c = cp.get(vkey(r.vendor_code, r.vendor_name));
    return {
      vendorCode: r.vendor_code,
      vendorName: r.vendor_name ?? '—',
      pos: Number(r.pos) || 0,
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
  Map<string, { capacityPerMonth: number; weekOf: string | null }>
> {
  const supabase = await client();
  const { data } = await supabase
    .from('sd_vendor_capacity_log')
    .select('vendor_code, capacity_per_month, week_of')
    .order('week_of', { ascending: false });

  const map = new Map<string, { capacityPerMonth: number; weekOf: string | null }>();
  (
    (data ?? []) as {
      vendor_code: string | null;
      capacity_per_month: number | null;
      week_of: string | null;
    }[]
  ).forEach((row) => {
    const code = (row.vendor_code ?? '').trim().toLowerCase();
    // Rows arrive newest-first, so the first one seen per vendor is the latest.
    if (code && !map.has(code)) {
      map.set(code, {
        capacityPerMonth: Number(row.capacity_per_month) || 0,
        weekOf: row.week_of ?? null,
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

export async function loadVendorCapacity() {
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

  const dashboard = await loadDashboardData();
  const rollups = buildVendorRollups(
    dashboard.pendingPos,
    dashboard.vendorTypes,
    dashboard.vendorMasters,
    dashboard.tnaRecords,
  );

  return {
    logs: (logs ?? []) as VendorCapacityLog[],
    multipliers: (multipliers ?? []) as VendorTypeMultiplier[],
    rollups,
    vendorMasters: dashboard.vendorMasters,
    vendorTypes: dashboard.vendorTypes,
  };
}
