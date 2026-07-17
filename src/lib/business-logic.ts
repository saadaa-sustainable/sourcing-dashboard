import type { PendingPo, TnaRecord, TrackerRow, VendorMaster, VendorRollup, VendorType } from './types';

export const TNA_STAGES = [
  { name: 'PP Sample Pending', actualField: 'pp_sample_actual_date' },
  { name: 'GPT Pending', actualField: 'gpt_actual_date' },
  { name: 'Cutting Pending', actualField: 'cutting_actual_date_first' },
  { name: 'Inline / Midline / QC Pending', actualField: 'in_line_actual_date' },
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

export function vendorBucket(label: string | null | undefined): 'Woven' | 'Knit' {
  return key(label).includes('woven') ? 'Woven' : 'Knit';
}

export function isOpenPo(row: PendingPo) {
  return number(row.pending_qty_actual) > 0;
}

export function isDelayedPo(row: PendingPo, today = new Date()) {
  const edd = parseIsoDate(row.expected_delivery_date);
  return isOpenPo(row) && Boolean(edd && daysBetween(today, edd) > 0);
}

export function isHighRiskPo(row: PendingPo, today = new Date()) {
  const edd = parseIsoDate(row.expected_delivery_date);
  return isOpenPo(row) && Boolean(edd) && number(row.pending_quantity) === number(row.original_quantity) &&
    daysBetween(edd!, today) <= 15;
}

export function ageingBucket(edd: string | null | undefined, today = new Date()) {
  const date = parseIsoDate(edd);
  if (!date) return 'No EDD';
  const overdue = Math.max(0, daysBetween(today, date));
  if (overdue === 0) return 'Not Due';
  if (overdue <= 7) return '0-7 Days';
  if (overdue <= 15) return '8-15 Days';
  if (overdue <= 30) return '16-30 Days';
  return '30+ Days';
}

export function deriveTnaStage(tna: TnaRecord | null | undefined) {
  if (!tna) return 'Not in TNA Tracker';
  for (const stage of TNA_STAGES) {
    if (!tna[stage.actualField]) return stage.name;
  }
  return 'Production';
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

export function buildTrackerRows(
  pendingPos: PendingPo[], vendorTypes: VendorType[], vendorMasters: VendorMaster[], tnaRecords: TnaRecord[],
  today = new Date(),
): TrackerRow[] {
  const lookups = createLookups(vendorTypes, vendorMasters, tnaRecords);
  const groups = new Map<string, PendingPo[]>();
  pendingPos.filter(isOpenPo).forEach((row) => {
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
    const vendor = resolveVendor(first, lookups);
    const tna = lookups.tnaByPo.get(key(first.po_ref_num)) ?? null;
    const delayDays = first.expected_delivery_date
      ? Math.max(0, daysBetween(today, parseIsoDate(first.expected_delivery_date)!)) : 0;
    return {
      key: groupKey, poRef: text(first.po_ref_num), productCode: text(first.product_code) || 'Unmapped',
      vendorName: text(first.vendor_name) || 'Unknown', vendorCode: text(first.vendor_code),
      merchant: vendor.merchant, vendorBucket: vendor.bucket, poType: text(first.po_type) || 'Unknown',
      variantCount: unique(rows.map((row) => text(row.product_variant)).filter(Boolean)).length,
      pendingQty: rows.reduce((sum, row) => sum + number(row.pending_qty_actual), 0),
      pendingValue: rows.reduce((sum, row) => sum + number(row.pending_qty_actual) * number(row.item_price), 0),
      edd: first.expected_delivery_date, delayDays, delayBucket: ageingBucket(first.expected_delivery_date, today),
      stage: deriveTnaStage(tna), skuRows: rows, tna,
    };
  }).sort((a, b) => b.pendingValue - a.pendingValue);
}

export function buildVendorRollups(
  pendingPos: PendingPo[], vendorTypes: VendorType[], vendorMasters: VendorMaster[], tnaRecords: TnaRecord[],
  today = new Date(),
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
      karigarLatest: number(resolved.master?.karigar_latest), capacityPerMonth: capacity,
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
