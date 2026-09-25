import type { EasycomStatus, InternalStatus, PendingPo, StageInspections, TnaEvent, TnaRecord, TrackerRow, VendorMaster, VendorRollup, VendorType } from './types';

// The critical-path stages, in order. Each carries its planned (TNA) date, the
// actual completion date, and the delay-days field. Extended per the approver beyond
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

/**
 * Calendar date of a stored value, as UTC midnight of that date. Plain dates
 * (YYYY-MM-DD) are IST business dates already. Timestamps (timestamptz, e.g.
 * "2026-09-14T19:30:00Z") are converted to their IST calendar date first — a PO
 * completed at 01:00 IST on the 15th must count as the 15th, not the 14th.
 */
const IST_OFFSET_MS = 5.5 * 60 * 60 * 1000;

export function parseIsoDate(value: string | null | undefined): Date | null {
  if (!value) return null;
  if (value.length > 10 && /[T ]\d{2}:\d{2}/.test(value)) {
    const t = Date.parse(value);
    if (Number.isNaN(t)) return null;
    const ist = new Date(t + IST_OFFSET_MS);
    return new Date(Date.UTC(ist.getUTCFullYear(), ist.getUTCMonth(), ist.getUTCDate()));
  }
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
export function istToday(now = new Date()): Date {
  const ist = new Date(now.getTime() + IST_OFFSET_MS);
  return new Date(Date.UTC(ist.getUTCFullYear(), ist.getUTCMonth(), ist.getUTCDate()));
}

/* ---- PO critical path: days in, dates out (spec 7.3) --------------- */

/**
 * The critical path is entered as DAYS, never as dates: "5 days for cutting" is a fact
 * about the work, while "6 September" is only true if the PO issued on the 4th. The days
 * are fixed at first submission; every date derives from them.
 *
 * Day 0 is the date the PO was created in EasyCom. Nothing physical can start before
 * that — no fabric moves on the strength of an internal approval — so a PO approved on
 * the 3rd and issued on the 4th has a critical path based on the 4th, and a PO that
 * issues ten days late simply moves ten days with it.
 */
export type TnaDays = {
  ppSample: number | null;
  gpt: number | null;
  cutting: number | null;
  inlineQc: number | null;
  firstDelivery: number | null;
  poClosing: number | null;
};

export type TnaDates = {
  ppSample: string | null;
  gpt: string | null;
  cutting: string | null;
  inlineQc: string | null;
  firstDelivery: string | null;
  poClosing: string | null;
};

/** Where the critical path is counting from, and whether that is real or provisional. */
export type TnaBase = {
  /** YYYY-MM-DD, or null when there is nothing to count from yet. */
  date: string | null;
  /**
   * `issued`    — the EasyCom PO issue date: the real thing.
   * `projected` — nothing issued yet, so the schedule is shown as if it issued today.
   *               It moves with the calendar until the PO is actually created.
   */
  source: 'issued' | 'projected';
};

const isoOf = (d: Date) => d.toISOString().slice(0, 10);

/** `base` + `n` days, as a plain date. Null days stay null — an unset stage has no date. */
export function addTnaDays(base: string | null | undefined, days: number | null | undefined): string | null {
  const start = parseIsoDate(base ?? null);
  if (!start || days == null || !Number.isFinite(days)) return null;
  return isoOf(new Date(start.getTime() + Math.round(days) * dayMs));
}

/**
 * What the critical path counts from: the EasyCom PO issue date once the PO exists there,
 * otherwise today — "if it issued now, this is the plan". Deliberately NOT the approval or
 * submission date: an approval with no EasyCom PO behind it starts nothing.
 */
export function tnaBaseFor(
  po: { po_issued_at?: string | null },
  today = istToday(),
): TnaBase {
  const issued = parseIsoDate(po.po_issued_at ?? null);
  return issued
    ? { date: isoOf(issued), source: 'issued' }
    : { date: isoOf(today), source: 'projected' };
}

/** Every stage date for a base date and a set of day offsets. */
export function tnaScheduleFrom(base: string | null | undefined, days: TnaDays): TnaDates {
  return {
    ppSample: addTnaDays(base, days.ppSample),
    gpt: addTnaDays(base, days.gpt),
    cutting: addTnaDays(base, days.cutting),
    inlineQc: addTnaDays(base, days.inlineQc),
    firstDelivery: addTnaDays(base, days.firstDelivery),
    poClosing: addTnaDays(base, days.poClosing),
  };
}

/**
 * Turn stage DATES back into days against a base — used when an approver adjusts a date
 * on the confirmation screen. Storing their edit as days is what lets the whole path move
 * with the PO if it issues later, instead of silently keeping a date they only chose
 * because of the issue date they assumed at the time.
 */
export function tnaDaysFromDates(base: string | null | undefined, dates: TnaDates): TnaDays {
  const start = parseIsoDate(base ?? null);
  const diff = (iso: string | null) => {
    const d = parseIsoDate(iso);
    return start && d ? daysBetween(d, start) : null;
  };
  return {
    ppSample: diff(dates.ppSample),
    gpt: diff(dates.gpt),
    cutting: diff(dates.cutting),
    inlineQc: diff(dates.inlineQc),
    firstDelivery: diff(dates.firstDelivery),
    poClosing: diff(dates.poClosing),
  };
}

/**
 * Spec 7.4 — approved here, but never created in EasyCom. Until it exists there the PO is
 * an internal decision and nothing downstream has begun, so the wait is worth counting on
 * its own: it is the one stretch of the cycle with no external cause.
 */
export function awaitingEasycomDays(
  po: { status?: string | null; approved_at?: string | null; po_issued_at?: string | null },
  today = istToday(),
): number | null {
  if (po.status !== 'approved' || po.po_issued_at) return null;
  const approved = parseIsoDate(po.approved_at ?? null);
  if (!approved) return null;
  return Math.max(0, daysBetween(today, approved));
}

/* ---- PO Closure SLA (spec §5) ------------------------------------- */
// Merchandiser leg ≤ 7d, finance leg ≤ 7d, total (completion → close) hard-capped
// at 15d. RAG is real-time so a still-open PO already past 15d reads red.
export const CLOSURE_SLA = { legDays: 7, totalCap: 15 } as const;

export type ClosureLeg = 'sourcing' | 'finance' | 'closed';
export type ClosureCompliance = {
  daysToMerch: number | null; // sourcing_submitted − completed
  daysToFinance: number | null; // finance_submitted − sourcing_submitted
  totalDays: number | null; // (closed ?? today) − completed
  status: 'on_time' | 'breached';
  rag: 'green' | 'amber' | 'red';
  leg: ClosureLeg;
};

export function computeClosureCompliance(
  c: {
    easycom_completed_at: string | null;
    sourcing_status: string;
    sourcing_submitted_at: string | null;
    finance_submitted_at: string | null;
    closed_at: string | null;
  },
  today = istToday(),
): ClosureCompliance {
  const completed = parseIsoDate(c.easycom_completed_at);
  const sourcing = parseIsoDate(c.sourcing_submitted_at);
  const finance = parseIsoDate(c.finance_submitted_at);
  const closed = parseIsoDate(c.closed_at);

  const daysToMerch = completed && sourcing ? daysBetween(sourcing, completed) : null;
  const daysToFinance = sourcing && finance ? daysBetween(finance, sourcing) : null;
  const leg: ClosureLeg = closed ? 'closed' : c.sourcing_status === 'submitted' ? 'finance' : 'sourcing';
  const totalDays = completed ? daysBetween(closed ?? today, completed) : null;
  const status: 'on_time' | 'breached' =
    totalDays != null && totalDays > CLOSURE_SLA.totalCap ? 'breached' : 'on_time';

  let rag: 'green' | 'amber' | 'red' = 'green';
  if (status === 'breached') {
    rag = 'red';
  } else if (leg !== 'closed' && completed) {
    // Amber/red on the current open leg's own elapsed days.
    const legStart = leg === 'finance' ? sourcing : completed;
    const legElapsed = legStart ? daysBetween(today, legStart) : 0;
    if (legElapsed > CLOSURE_SLA.legDays) rag = 'red';
    else if (legElapsed >= 5) rag = 'amber';
  }
  return { daysToMerch, daysToFinance, totalDays, status, rag, leg };
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
 * High Risk (the approver's rule): a PO is high risk if ANY critical-path stage is
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
      // Weave is the product's, from the master (baked on at load); the vendor's
      // type is only a fallback for codes the master doesn't cover.
      merchant: vendor.merchant, vendorBucket: first.master_weave ?? vendor.bucket, poType: text(first.po_type) || 'Unknown',
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

/**
 * The three PO types, with the stock cover each is expected to carry. stockDays is the live
 * value; the FOB count is 75 (confirmed 2026-09-22, full and final) and matches the Rules Master
 * (sd_analytics_rule.lead_days_fob = 75), which stays the authoritative day-count for
 * lead-time and coverage everywhere.
 *
 * multiplier mirrors the sd_vendor_type_multiplier master so the two do not drift, but it no
 * longer scales capacity: on the team's instruction capacity is karigars × daily output ×
 * working days, and the commercial terms of a PO do not make anyone sew faster. See
 * vendorMonthlyCapacity.
 *
 * There used to be a fourth type, efob_fob at 2.0, for the five vendors typed "EFOB/FOB" in
 * the vendor master. It was dropped on the team's instruction that those vendors use the
 * E-FOB formula, so normaliseVendorType folds "EFOB/FOB" into efob.
 */
export const VENDOR_TYPE_MULTIPLIER: Record<string, { label: string; multiplier: number; stockDays: number }> = {
  job_work: { label: 'Job work', multiplier: 1.0, stockDays: 30 },
  efob: { label: 'E-FOB', multiplier: 1.5, stockDays: 45 },
  fob: { label: 'FOB', multiplier: 2.5, stockDays: 75 },
};

// EasyEcom's raw vendor status (vendor_master_data.ee_status, pulled through GCP)
// decoded to a tri-state: true = active, false = inactive, null = unknown / not
// yet synced (caller should fall back to the Vendor_Type_Master status). Handles
// the common encodings (1/0, true/false, active/inactive, enabled/disabled, yes/no).
const EE_ACTIVE = new Set(['1', 'true', 'active', 'enabled', 'yes', 'y']);
const EE_INACTIVE = new Set(['0', 'false', 'inactive', 'disabled', 'no', 'n']);
export function eeVendorActive(status: string | null | undefined): boolean | null {
  const s = key(status);
  if (!s) return null;
  if (EE_ACTIVE.has(s)) return true;
  if (EE_INACTIVE.has(s)) return false;
  return null;
}

/**
 * Does this string actually name a PO type (Job Work / E-FOB / FOB)?
 *
 * normaliseVendorType falls back to job_work for anything it does not recognise, which is a
 * safe default but silently swallows a wrong field. Vendor_Type_Master.vendor_type holds the
 * FABRIC WEAVE ("Woven" / "Knitwear") for every vendor, so feeding it to the capacity model
 * typed all 21 vendors as Job Work — a 30-day lead instead of 45/75 — understating PO capacity
 * and overstating utilisation everywhere. Use this to pick a field that really is a PO type.
 */
export function isPoVendorType(raw: string | null | undefined): boolean {
  const v = key(raw);
  return v.includes('job') || v.includes('efob') || v.includes('e-fob') || v.includes('fob');
}

export function normaliseVendorType(raw: string | null | undefined): string {
  const v = key(raw);
  if (v.includes('job')) return 'job_work';
  // "EFOB/FOB" counts as E-FOB: the team's call, and the reason the old efob_fob entry went.
  const hasEfob = v.includes('efob') || v.includes('e-fob');
  if (hasEfob) return 'efob';
  if (v.includes('fob')) return 'fob';
  return 'job_work';
}

/** Defaults for the capacity formula; both live in Rules Master and are editable there. */
export const KARIGAR_DAILY_OUTPUT = 20;
export const WORKING_DAYS_PER_MONTH = 26;

/* ------------------------------------------------------------------ */
/* THE capacity model — one function, every screen                     */
/* ------------------------------------------------------------------ */

/** Everything the capacity maths reads from Rules Master. No constant in code decides a number. */
export type CapacityRules = {
  /** Pieces one worker makes in a day (karigar_daily_output). */
  dailyOutput: number;
  /** Working days in a month (working_days_per_month). */
  workingDays: number;
  /** Lead time per PO type in calendar days (lead_days_job / lead_days_efob / lead_days_fob). */
  leadDays: { job_work: number; efob: number; fob: number };
  /** capacity_driver_min_machines = 1: workers = min(machines, karigars); 0: workers = karigars. */
  driverMinMachines: boolean;
};

export const DEFAULT_CAPACITY_RULES: CapacityRules = {
  dailyOutput: KARIGAR_DAILY_OUTPUT,
  workingDays: WORKING_DAYS_PER_MONTH,
  leadDays: { job_work: 30, efob: 45, fob: 75 },
  driverMinMachines: false,
};

/** Read the capacity rules out of the Rules Master map, defaults where a key is missing. */
export function capacityRulesFrom(rules: Record<string, number> | null | undefined): CapacityRules {
  const r = rules ?? {};
  const n = (v: number | undefined, d: number) => (Number.isFinite(v) && (v as number) > 0 ? (v as number) : d);
  return {
    dailyOutput: n(r.karigar_daily_output, KARIGAR_DAILY_OUTPUT),
    workingDays: n(r.working_days_per_month, WORKING_DAYS_PER_MONTH),
    leadDays: {
      job_work: n(r.lead_days_job, 30),
      efob: n(r.lead_days_efob, 45),
      fob: n(r.lead_days_fob, 90),
    },
    driverMinMachines: Number(r.capacity_driver_min_machines) === 1,
  };
}

export type CapacityModel = {
  /** False when nothing usable has been entered — every figure below is then 0 / null and
   *  the vendor must be left out of totals and utilisation, not counted as zero capacity. */
  entered: boolean;
  /** The workers the output is limited by (karigars, or min(machines, karigars) by rule). */
  workers: number;
  /** Lead days for this vendor's PO type. */
  leadDays: number;
  capacityPerDay: number;
  capacityPerMonth: number;
  /** What the vendor can make inside one PO's lead time — the pipeline it can legitimately hold. */
  poCapacity: number;
  /** poCapacity − in process; null when not entered. Negative = past capacity. */
  available: number | null;
  /** in process ÷ poCapacity × 100, one decimal, NOT capped: 148 means 148%. null when not entered. */
  capacityUtil: number | null;
  /** karigars ÷ machines × 100; null when no machines. */
  machineUtil: number | null;
  /** in process exceeds poCapacity (only ever true when entered). */
  over: boolean;
};

/**
 * The single capacity calculation. Entry, Reporting, Vendor Performance, PO Approval and
 * the dashboard's over-capacity count all call this; nothing recomputes it on its own.
 *
 *     workers            = karigars (or min(machines, karigars) when the rule says so)
 *     capacity per day   = workers × pieces per worker per day
 *     capacity per month = capacity per day × working days in a month
 *     PO capacity        = capacity per day × working days inside the PO type's lead time
 *                        = capacity per month × lead days ÷ 30
 *     available          = PO capacity − in process
 *     utilisation        = in process ÷ PO capacity
 *
 * Why PO capacity and not the month: an E-FOB order occupies a vendor for 45 days and a
 * FOB order for 75, so their pipelines legitimately hold more than one month of output.
 * Comparing in-process to one month flagged every normal FOB vendor as over capacity.
 * Job Work (30 days) is unchanged by this; the multiplier was 1.0 and hid the bug.
 */
export function vendorCapacityModel(
  input: {
    machines: number | null | undefined;
    karigar: number | null | undefined;
    vendorType: string | null | undefined;
    inProcessQty: number | null | undefined;
  },
  rules: CapacityRules = DEFAULT_CAPACITY_RULES,
): CapacityModel {
  const machines = Math.max(0, number(input.machines));
  const karigar = Math.max(0, number(input.karigar));
  const inProcess = Math.max(0, number(input.inProcessQty));
  const typeKey = normaliseVendorType(input.vendorType) as keyof CapacityRules['leadDays'];
  const leadDays = rules.leadDays[typeKey] ?? rules.leadDays.job_work;
  const workers = rules.driverMinMachines ? Math.min(machines, karigar) : karigar;
  const entered = workers > 0;
  const capacityPerDay = entered ? workers * rules.dailyOutput : 0;
  const capacityPerMonth = Math.round(capacityPerDay * rules.workingDays);
  // Lead days are calendar days; the working days inside them scale by workingDays/30.
  const poCapacity = Math.round(capacityPerDay * leadDays * (rules.workingDays / 30));
  const machineUtil = machines > 0 ? Math.round((karigar / machines) * 100) : null;
  return {
    entered,
    workers,
    leadDays,
    capacityPerDay,
    capacityPerMonth,
    poCapacity,
    available: entered ? poCapacity - inProcess : null,
    capacityUtil: entered && poCapacity > 0 ? Math.round((inProcess / poCapacity) * 1000) / 10 : null,
    machineUtil,
    over: entered && inProcess > poCapacity,
  };
}

/**
 * A vendor's monthly capacity, in pieces:
 *
 *     karigars × pieces one karigar makes in a day × working days in a month
 *
 * People sew garments, so people are the constraint. The old formula multiplied machines by
 * karigars and then by a type multiplier, which produced a number nobody could derive from
 * anything on the floor: a vendor with 40 machines stating 1,000 a month came out at 2,500.
 * Machines are still recorded — they are worth knowing, and machine utilisation is karigars
 * against machines — but they no longer decide how much a vendor can make.
 *
 * The type multiplier is gone from this calculation too. How much a vendor can produce does
 * not change because the commercial terms are FOB rather than job work.
 */
export function vendorMonthlyCapacity(
  karigar: number | null | undefined,
  dailyOutput = KARIGAR_DAILY_OUTPUT,
  workingDays = WORKING_DAYS_PER_MONTH,
): number {
  return vendorCapacityModel(
    { machines: null, karigar, vendorType: 'job', inProcessQty: 0 },
    { ...DEFAULT_CAPACITY_RULES, dailyOutput: number(dailyOutput), workingDays: number(workingDays) },
  ).capacityPerMonth;
}

export function buildVendorRollups(
  pendingPos: PendingPo[], vendorTypes: VendorType[], vendorMasters: VendorMaster[], tnaRecords: TnaRecord[],
  today = istToday(),
  capacityByVendor: Map<string, { machines: number; karigar: number }> = new Map(),
  rules: CapacityRules = DEFAULT_CAPACITY_RULES,
): VendorRollup[] {
  const tracker = buildTrackerRows(pendingPos, vendorTypes, vendorMasters, tnaRecords, today);
  const lookups = createLookups(vendorTypes, vendorMasters, tnaRecords);
  // Split each vendor per weave: a vendor supplying both Woven and Knit products
  // yields one rollup per weave (qty/value/PO counts scoped to that weave), since
  // weave is now the product's, not the vendor's. Capacity stays vendor-level.
  const byVendor = new Map<string, TrackerRow[]>();
  tracker.forEach((row) => {
    const groupKey = `${key(row.vendorCode || row.vendorName)}${row.vendorBucket}`;
    byVendor.set(groupKey, [...(byVendor.get(groupKey) ?? []), row]);
  });
  return [...byVendor.values()].map((rows) => {
    const first = rows[0];
    const sample = rows[0].skuRows[0];
    const resolved = resolveVendor(sample, lookups);
    const capacitySigned = number(resolved.master?.capacity_per_month);
    const live = capacityByVendor.get(key(first.vendorCode)) ?? capacityByVendor.get(key(first.vendorName));
    const openQty = rows.reduce((sum, row) => sum + row.pendingQty, 0);
    // The one capacity model. Live sheet figures first, the master's onboarding figures as
    // the fallback. The PO type is the COMMERCIAL type and lives in the vendor master's
    // primary_type — Vendor_Type_Master.vendor_type is the fabric weave ("Woven"/"Knitwear"),
    // and reading it here typed every vendor as Job Work. Take the first field that really
    // is a PO type; undefined falls back to job_work inside the model, as before.
    const machinesForCapacity =
      live?.machines ?? resolved.master?.machines_for_saadaa ?? resolved.master?.total_machines;
    const karigarForCapacity = live?.karigar ?? resolved.master?.total_active_karigar;
    const model = vendorCapacityModel(
      {
        machines: machinesForCapacity,
        karigar: karigarForCapacity,
        vendorType: [resolved.master?.primary_type, resolved.type?.vendor_type].find(isPoVendorType),
        inProcessQty: openQty,
      },
      rules,
    );
    const openPoRefs = unique(rows.map((row) => row.poRef));
    const delayedRefs = unique(rows.filter((row) => row.delayDays > 0).map((row) => row.poRef));
    return {
      vendorCode: first.vendorCode, vendorName: first.vendorName, merchant: first.merchant,
      vendorBucket: first.vendorBucket, openPoCount: openPoRefs.length, delayedPoCount: delayedRefs.length,
      delayPct: openPoRefs.length ? Math.round(delayedRefs.length / openPoRefs.length * 100) : 0,
      openQty, openValue: rows.reduce((sum, row) => sum + row.pendingValue, 0),
      // These three columns must match their own documented meaning (header-help.ts), and the
      // row has to be derivable: capacity is built on the karigar figure shown beside it.
      // "Machines" = allocated to SAADAA, as entered on Vendor Capacity (NOT the vendor's
      // total factory); "Latest karigar" = the most recent Vendor Capacity entry; only
      // "Active karigar" is the master's onboarding figure.
      totalMachines: number(machinesForCapacity),
      totalActiveKarigar: number(resolved.master?.total_active_karigar),
      karigarLatest: number(live?.karigar ?? resolved.master?.karigar_latest),
      capacityPerMonth: model.capacityPerMonth, poCapacity: model.poCapacity, capacitySigned,
      capacityEntered: model.entered,
      // Utilisation = open qty ÷ PO capacity, from the one model. Real percentage, not capped.
      utilizationPct: model.capacityUtil ?? 0,
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
