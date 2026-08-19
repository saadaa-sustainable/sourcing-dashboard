import type { EasycomStatus, InternalStatus, PendingPo, StageInspections, TnaEvent, TnaRecord, TrackerRow, VendorMaster, VendorRollup, VendorType } from './types';

// The critical-path stages, in order. Each carries its planned (TNA) date, the
// actual completion date, and the delay-days field. Extended per Mahesh beyond
// Inline through First Delivery and PO Closer (from the TNA Update sheet).
export const TNA_STAGES = [
  { name: 'PP Sample', tnaField: 'pp_sample_tna_date', actualField: 'pp_sample_actual_date', delayField: 'pp_sample_delay_days', core: true },
  { name: 'GPT', tnaField: 'gpt_tna_date', actualField: 'gpt_actual_date', delayField: 'gpt_delay_days', core: true },
  { name: 'Cutting', tnaField: 'cutting_tna_date', actualField: 'cutting_actual_date_first', delayField: 'cutting_delay_days', core: true },
  { name: 'Inline / Midline QC', tnaField: 'in_line_tna_date', actualField: 'in_line_actual_date', delayField: 'in_line_qc_delay_days', core: true },
  { name: 'First Delivery', tnaField: 'first_delivery_tna_date', actualField: 'first_delivery_actual_date', delayField: 'first_delivery_delay_days', core: false },
  { name: 'PO Closer', tnaField: 'po_closer_tna_date', actualField: 'po_closer_actual_date', delayField: 'po_closer_delay_days', core: false },
] as const;

const dayMs = 86_400_000;
const text = (value: string | null | undefined) => (value ?? '').trim();
const key = (value: string | null | undefined) => text(value).toLowerCase();
const number = (value: number | null | undefined) => Number.isFinite(value) ? Number(value) : 0;
const unique = <T,>(items: T[]) => [...new Set(items)];

export function parseIsoDate(value: string | null | undefined): Date | null {
  if (!value) return null;
  const date = new Date(`${value.slice(0, 10)}T00:00:00Z`);
  return Number.isNaN(date.getTime()) ? null : date;
}

export function daysBetween(later: Date, earlier: Date) {
  return Math.floor((Date.UTC(later.getUTCFullYear(), later.getUTCMonth(), later.getUTCDate()) -
    Date.UTC(earlier.getUTCFullYear(), earlier.getUTCMonth(), earlier.getUTCDate())) / dayMs);
}

// Business dates (EDD, TNA milestones) are plain IST calendar dates, so "today"
// must be the current calendar date in IST (UTC+5:30). A UTC "today" runs a day
// behind between 00:00 and 05:30 IST and would mis-flag same-day events and delay
// boundaries. Returned as UTC midnight of the IST date so it lines up with
// parseIsoDate, which anchors every stored date at 00:00Z.
const IST_OFFSET_MS = 5.5 * 60 * 60 * 1000;
export function istToday(now = new Date()): Date {
  const ist = new Date(now.getTime() + IST_OFFSET_MS);
  return new Date(Date.UTC(ist.getUTCFullYear(), ist.getUTCMonth(), ist.getUTCDate()));
}

export function vendorBucket(label: string | null | undefined): 'Woven' | 'Knit' | 'Other' {
  const k = key(label);
  if (k.includes('woven')) return 'Woven';
  if (k.includes('knit')) return 'Knit';
  return 'Other';
}

export function isOpenPo(row: PendingPo) {
  return number(row.pending_qty_actual) > 0;
}

export function isDelayedPo(row: PendingPo, today = istToday()) {
  const edd = parseIsoDate(row.expected_delivery_date);
  return isOpenPo(row) && Boolean(edd && daysBetween(today, edd) > 0);
}

/**
 * High Risk (Mahesh's rule): a PO is high risk if ANY critical-path stage is
 * overdue as of today — its planned (TNA) date has passed with no actual date —
 * regardless of how much runway remains to final delivery. A single overdue
 * stage compounds forward, so it flags immediately to force recovery.
 */
export function isTnaHighRisk(tna: TnaRecord | null | undefined, today = istToday()) {
  if (!tna) return false;
  for (const stage of TNA_STAGES) {
    if (tna[stage.actualField]) continue; // stage done
    const planned = parseIsoDate(tna[stage.tnaField]);
    if (planned && daysBetween(today, planned) > 0) return true; // planned date passed, not done
  }
  return false;
}

/** High-risk test for an open PO line, using its matched TNA record. */
export function isHighRiskLine(
  row: PendingPo,
  tnaByPo: Map<string, TnaRecord>,
  today = istToday(),
) {
  return isOpenPo(row) && isTnaHighRisk(tnaByPo.get(key(row.po_ref_num)), today);
}

// Layer 3 (Due Today): a critical-path TNA stage is planned for TODAY and not yet
// done. Distinct from High Risk / Overdue (already-past) - a live act-now signal.
export function isTnaDueToday(tna: TnaRecord | null | undefined, today = istToday()): boolean {
  if (!tna) return false;
  for (const stage of TNA_STAGES) {
    if (tna[stage.actualField]) continue; // stage done
    const planned = parseIsoDate(tna[stage.tnaField]);
    if (planned && daysBetween(today, planned) === 0) return true; // planned exactly today
  }
  return false;
}

export function ageingBucket(edd: string | null | undefined, today = istToday()) {
  const date = parseIsoDate(edd);
  if (!date) return 'No EDD';
  const overdue = Math.max(0, daysBetween(today, date));
  if (overdue === 0) return 'Not Due';
  if (overdue <= 7) return '0-7 Days';
  if (overdue <= 15) return '8-15 Days';
  if (overdue <= 30) return '16-30 Days';
  return '30+ Days';
}

/**
 * Where the PO currently sits on the critical path. Prefers the ingested
 * "Current Production Stage" (from TNA Update) when present; otherwise walks the
 * stages and returns the first not-yet-done one. Core stages (through Inline)
 * always count; the extended stages count only once they carry a planned date.
 */
export function deriveTnaStage(tna: TnaRecord | null | undefined) {
  if (!tna) return 'Not in TNA Tracker';
  // Current stage = the earliest stage whose actual date is not yet populated.
  for (const stage of TNA_STAGES) {
    if (tna[stage.actualField]) continue; // done
    if (stage.core || tna[stage.tnaField]) return `${stage.name} Pending`;
  }
  return 'Production';
}

// A PO with NO TNA stage data ever entered (no record, or every core stage blank on
// both planned and actual). This is an ADOPTION GAP, distinct from delayed/pending -
// surfaced so missing entry can be chased and mandated.
export function isTnaDataMissing(tna: TnaRecord | null | undefined): boolean {
  if (!tna) return true;
  for (const stage of TNA_STAGES) {
    if (!stage.core) continue;
    if (tna[stage.tnaField] || tna[stage.actualField]) return false;
  }
  return true;
}

// EasyCom lifecycle guard: the tracker is the ACTIVE/open view, so a PO that has left
// the Approved state (Completed/Closed/Cancelled/Rejected on EasyCom) drops out. The
// data source (sd_po_dashboard) is already Approved-only; this is a defensive backstop.
const EASYCOM_INACTIVE = new Set(['completed', 'closed', 'cancelled', 'canceled', 'rejected']);
export function isEasycomActive(row: PendingPo): boolean {
  const status = key(row.po_status);
  return !status || !EASYCOM_INACTIVE.has(status);
}

export function createLookups(vendorTypes: VendorType[], vendorMasters: VendorMaster[], tnaRecords: TnaRecord[]) {
  const typesByCode = new Map(vendorTypes.map((row) => [key(row.vendor_code), row]));
  const typesByName = new Map(vendorTypes.map((row) => [key(row.vendor_name), row]));
  const mastersByCode = new Map(vendorMasters.map((row) => [key(row.vendor_code), row]));
  const mastersByName = new Map(vendorMasters.map((row) => [key(row.vendor_name), row]));
  const tnaByPo = new Map(tnaRecords.map((row) => [key(row.po_no), row]));
  return { typesByCode, typesByName, mastersByCode, mastersByName, tnaByPo };
}

export function resolveVendor(row: PendingPo, lookups: ReturnType<typeof createLookups>) {
  const type = lookups.typesByCode.get(key(row.vendor_code)) ?? lookups.typesByName.get(key(row.vendor_name));
  const master = lookups.mastersByCode.get(key(row.vendor_code)) ?? lookups.mastersByName.get(key(row.vendor_name));
  return {
    type,
    master,
    merchant: text(master?.merchant_name) || text(type?.merchant_name) || 'Unassigned',
    bucket: vendorBucket(type?.vendor_type),
  };
}

export type StageDelay = { state: 'On Time' | 'Delay' | 'Pending' | 'None'; days: number };

/**
 * Per-stage schedule variance for one TNA stage: planned (TNA) date vs actual.
 *   - actual on/before planned  -> On Time (days = days early, >= 0)
 *   - actual after planned       -> Delay   (days = days late)
 *   - planned set, no actual yet  -> Pending
 *   - no planned baseline         -> None
 */
export function stageDelay(planned: string | null | undefined, actual: string | null | undefined): StageDelay {
  const a = parseIsoDate(actual);
  const p = parseIsoDate(planned);
  if (!a) return { state: p ? 'Pending' : 'None', days: 0 };
  if (!p) return { state: 'None', days: 0 };
  const d = daysBetween(a, p); // >0 = actual after planned = late
  return d > 0 ? { state: 'Delay', days: d } : { state: 'On Time', days: -d || 0 };
}

/**
 * TNA stages are strictly linear (PP → GPT → Cutting → Inline → First Delivery →
 * PO Closer). "Done" = the stage's actual date is populated. In a valid record the
 * Done stages form an unbroken prefix: once a stage is not-done, no later stage may
 * be done. Returns the names of stages that are Done while an earlier stage is still
 * blank — a data-entry error (e.g. GPT done but PP Sample blank). Empty when valid.
 */
export function tnaSequenceErrors(tna: TnaRecord | null | undefined): string[] {
  if (!tna) return [];
  const out: string[] = [];
  let seenPending = false;
  for (const stage of TNA_STAGES) {
    if (tna[stage.actualField]) {
      if (seenPending) out.push(stage.name); // completed after an earlier pending stage
    } else {
      seenPending = true;
    }
  }
  return out;
}

/** True when the TNA stages are out of order (a later stage done before an earlier). */
export function hasTnaSequenceError(tna: TnaRecord | null | undefined): boolean {
  return tnaSequenceErrors(tna).length > 0;
}

/** Total accumulated TNA delay (ingested Total Delay Days, else sum of stage delays). */
export function tnaTotalDelayDays(tna: TnaRecord | null | undefined): number {
  if (!tna) return 0;
  return tna.total_delay_days ??
    (tna.pp_sample_delay_days + tna.gpt_delay_days + tna.cutting_delay_days + tna.in_line_qc_delay_days +
      (tna.first_delivery_delay_days ?? 0) + (tna.po_closer_delay_days ?? 0));
}

// The internal TNA/Risk status values, urgent-first (drives the tracker filter tabs).
export const INTERNAL_STATUSES: InternalStatus[] = ['Overdue', 'High Risk', 'On Track'];

/**
 * The single Layer-2 (TNA/Risk) status per PO group, precedence top-down:
 *   Overdue   - EDD has passed (delayDays > 0), EDD-only
 *   High Risk - ANY critical-path TNA stage is overdue (planned passed, not done) - pure TNA
 *   On Track  - inverse of High Risk
 * Deliberately NOT influenced by demand/inventory. Due Today / Delayed were removed.
 */
export function computeInternalStatus(input: {
  delayDays: number; highRisk: boolean;
}): InternalStatus {
  if (input.delayDays > 0) return 'Overdue';
  if (input.highRisk) return 'High Risk';
  return 'On Track';
}

/**
 * Layer-1 (EasyCom / delivery) status from received-vs-ordered:
 *   received === 0              -> Approved         (nothing received yet)
 *   received >= 95% of ordered  -> Closure Pending  (functionally done, not closed on EasyCom)
 *   otherwise                   -> Partially Received
 */
export function easycomBucket(orderedQty: number, receivedQty: number): EasycomStatus {
  if (receivedQty <= 0) return 'Approved';
  if (orderedQty > 0 && receivedQty >= 0.95 * orderedQty) return 'Closure Pending';
  return 'Partially Received';
}

export function buildTrackerRows(
  pendingPos: PendingPo[], vendorTypes: VendorType[], vendorMasters: VendorMaster[], tnaRecords: TnaRecord[],
  today = istToday(),
  inspectionsByPo?: Record<string, StageInspections>,
  opts?: { includeClosurePending?: boolean },
): TrackerRow[] {
  const lookups = createLookups(vendorTypes, vendorMasters, tnaRecords);
  const groups = new Map<string, PendingPo[]>();
  // Default: open lines (pending>0). With includeClosurePending, also keep fully-received
  // active lines so near/fully-received Approved POs surface (received/ordered stay complete).
  const keepLine = opts?.includeClosurePending
    ? (row: PendingPo) => isEasycomActive(row) && number(row.original_quantity) > 0
    : (row: PendingPo) => isOpenPo(row) && isEasycomActive(row);
  pendingPos.filter(keepLine).forEach((row) => {
    // Grouped by PO ref + product code + EDD. The EDD belongs in the key because a
    // single (po_ref_num, product_code) pair can legitimately carry lines with
    // different delivery dates; keying on the first two alone let one arbitrary
    // row decide the whole group's EDD, delay days and ageing bucket.
    const groupKey = [text(row.po_ref_num), text(row.product_code), text(row.expected_delivery_date)]
      .join('\u001f');
    groups.set(groupKey, [...(groups.get(groupKey) ?? []), row]);
  });
  return [...groups.entries()].map(([groupKey, rows]) => {
    const first = rows[0];
    const variants = unique(rows.map((row) => text(row.product_variant)).filter(Boolean));
    const vendor = resolveVendor(first, lookups);
    const tna = lookups.tnaByPo.get(key(first.po_ref_num)) ?? null;
    const delayDays = first.expected_delivery_date
      ? Math.max(0, daysBetween(today, parseIsoDate(first.expected_delivery_date)!)) : 0;
    const highRisk = isTnaHighRisk(tna, today);
    const orderedQty = rows.reduce((sum, row) => sum + number(row.original_quantity), 0);
    const receivedQty = rows.reduce((sum, row) => sum + Math.max(0, number(row.original_quantity) - number(row.pending_qty_actual)), 0);
    const easycomStatus: EasycomStatus = easycomBucket(orderedQty, receivedQty);
    return {
      key: groupKey, poRef: text(first.po_ref_num), productCode: text(first.product_code) || 'Unmapped',
      vendorName: text(first.vendor_name) || 'Unknown', vendorCode: text(first.vendor_code),
      merchant: vendor.merchant, vendorBucket: vendor.bucket, poType: text(first.po_type) || 'Unknown',
      poNumber: text(first.po_number),
      variantCount: variants.length, variantName: variants.length === 1 ? variants[0] : '',
      pendingQty: rows.reduce((sum, row) => sum + number(row.pending_qty_actual), 0),
      pendingValue: rows.reduce((sum, row) => sum + number(row.pending_qty_actual) * number(row.item_price), 0),
      edd: first.expected_delivery_date, delayDays, delayBucket: ageingBucket(first.expected_delivery_date, today),
      stage: deriveTnaStage(tna), highRisk, dueToday: isTnaDueToday(tna, today), skuRows: rows, tna,
      orderedQty, receivedQty, easycomStatus,
      internalStatus: computeInternalStatus({ delayDays, highRisk }),
      sequenceError: hasTnaSequenceError(tna),
      tnaMissing: isTnaDataMissing(tna),
      inspections: inspectionsByPo?.[text(first.po_ref_num).toUpperCase()],
    };
  }).sort((a, b) => b.pendingValue - a.pendingValue);
}

/**
 * Flattens tracker rows into per-stage TNA "events". For each open PO's matched
 * TNA record, every critical-path stage that has no actual date yet and whose
 * planned (TNA) date is today or earlier becomes an event:
 *   - status 'today'   — planned date is today (overdueDays === 0)
 *   - status 'delayed' — planned date has passed (overdueDays > 0)
 * Future stages (planned date after today) are skipped. Same per-stage rule as
 * isTnaHighRisk. Sorted most-overdue first.
 */
export function buildTnaEvents(rows: TrackerRow[], today = istToday()): TnaEvent[] {
  const events: TnaEvent[] = [];
  // A TNA milestone belongs to the PO, but one PO can span several tracker
  // rows (multiple EDDs/product codes) sharing the same TNA record. Emit each
  // (PO, stage) milestone once - from the first, highest-value row.
  const seen = new Set<string>();
  for (const row of rows) {
    const tna = row.tna;
    if (!tna) continue;
    for (const stage of TNA_STAGES) {
      if (tna[stage.actualField]) continue; // stage already completed
      const planned = parseIsoDate(tna[stage.tnaField]);
      if (!planned) continue;
      const overdueDays = daysBetween(today, planned); // >0 late, 0 today, <0 upcoming
      if (overdueDays < 0) continue; // not due yet
      const dedupeKey = `${key(row.poRef)}${stage.name}`;
      if (seen.has(dedupeKey)) continue;
      seen.add(dedupeKey);
      events.push({
        key: dedupeKey,
        poRef: row.poRef, productCode: row.productCode,
        vendorName: row.vendorName, vendorCode: row.vendorCode, merchant: row.merchant,
        stage: stage.name, plannedDate: text(tna[stage.tnaField]),
        status: overdueDays > 0 ? 'delayed' : 'today', overdueDays, row,
      });
    }
  }
  return events.sort((a, b) => b.overdueDays - a.overdueDays);
}

// Vendor-type capacity model (single source of truth). PO capacity = machines ×
// karigar × multiplier; stockDays = day-coverage (multiplier × 30). E-FOB corrected
// to 45 days (was 41). Only Machines & Karigar are ever hand-entered; the rest derive.
export const VENDOR_TYPE_MULTIPLIER: Record<string, { label: string; multiplier: number; stockDays: number }> = {
  job_work: { label: 'Job work', multiplier: 1.0, stockDays: 30 },
  efob: { label: 'E-FOB', multiplier: 1.5, stockDays: 45 },
  fob: { label: 'FOB', multiplier: 2.5, stockDays: 75 },
  efob_fob: { label: 'E-FOB/FOB', multiplier: 2.0, stockDays: 60 },
};

export function normaliseVendorType(raw: string | null | undefined): string {
  const v = key(raw);
  if (v.includes('job')) return 'job_work';
  const hasEfob = v.includes('efob') || v.includes('e-fob');
  if (hasEfob && v.includes('/')) return 'efob_fob';
  if (hasEfob) return 'efob';
  if (v.includes('fob')) return 'fob';
  return 'job_work';
}

// PO capacity for a vendor = machines × karigar × type multiplier (rounded).
export function vendorPoCapacity(machines: number | null | undefined, karigar: number | null | undefined, type: string | null | undefined): number {
  const mult = VENDOR_TYPE_MULTIPLIER[normaliseVendorType(type)]?.multiplier ?? 1;
  return Math.round(number(machines) * number(karigar) * mult);
}

export function buildVendorRollups(
  pendingPos: PendingPo[], vendorTypes: VendorType[], vendorMasters: VendorMaster[], tnaRecords: TnaRecord[],
  today = istToday(),
  capacityByVendor: Map<string, { machines: number; karigar: number }> = new Map(),
): VendorRollup[] {
  const tracker = buildTrackerRows(pendingPos, vendorTypes, vendorMasters, tnaRecords, today);
  const lookups = createLookups(vendorTypes, vendorMasters, tnaRecords);
  const byVendor = new Map<string, TrackerRow[]>();
  tracker.forEach((row) => byVendor.set(key(row.vendorCode || row.vendorName), [...(byVendor.get(key(row.vendorCode || row.vendorName)) ?? []), row]));
  return [...byVendor.values()].map((rows) => {
    const first = rows[0];
    const sample = rows[0].skuRows[0];
    const resolved = resolveVendor(sample, lookups);
    const capacity = number(resolved.master?.capacity_per_month);
    const live = capacityByVendor.get(key(first.vendorCode)) ?? capacityByVendor.get(key(first.vendorName));
    const poCapacity = vendorPoCapacity(
      live?.machines ?? resolved.master?.total_machines,
      live?.karigar ?? resolved.master?.total_active_karigar,
      resolved.master?.primary_type ?? resolved.type?.vendor_type,
    );
    const openQty = rows.reduce((sum, row) => sum + row.pendingQty, 0);
    const openPoRefs = unique(rows.map((row) => row.poRef));
    const delayedRefs = unique(rows.filter((row) => row.delayDays > 0).map((row) => row.poRef));
    return {
      vendorCode: first.vendorCode, vendorName: first.vendorName, merchant: first.merchant,
      vendorBucket: first.vendorBucket, openPoCount: openPoRefs.length, delayedPoCount: delayedRefs.length,
      delayPct: openPoRefs.length ? Math.round(delayedRefs.length / openPoRefs.length * 100) : 0,
      openQty, openValue: rows.reduce((sum, row) => sum + row.pendingValue, 0),
      totalMachines: number(resolved.master?.total_machines),
      totalActiveKarigar: number(resolved.master?.total_active_karigar),
      karigarLatest: number(resolved.master?.karigar_latest), capacityPerMonth: capacity, poCapacity,
      // Utilisation = open qty ÷ monthly capacity (the master's signed capacity/month),
      // matching the Merchant rollup and the documented formula.
      utilizationPct: capacity ? Math.round(openQty / capacity * 100) : 0,
    };
  }).sort((a, b) => b.openValue - a.openValue);
}

export function aggregateProductRows(rows: TrackerRow[]) {
  const groups = new Map<string, { productCode: string; variant: string; vendor: string; merchant: string; poType: string; qty: number; value: number }>();
  rows.flatMap((row) => row.skuRows.map((sku) => ({ row, sku }))).forEach(({ row, sku }) => {
    const variant = text(sku.product_variant) || 'Unmapped';
    const k = `${row.productCode}\u001f${variant}`;
    const current = groups.get(k) ?? { productCode: row.productCode, variant, vendor: row.vendorName, merchant: row.merchant, poType: row.poType, qty: 0, value: 0 };
    current.qty += number(sku.pending_qty_actual);
    current.value += number(sku.pending_qty_actual) * number(sku.item_price);
    groups.set(k, current);
  });
  return [...groups.values()].sort((a, b) => b.qty - a.qty);
}
