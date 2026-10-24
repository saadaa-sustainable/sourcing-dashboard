import type { PlanLine, PeriodKind } from './types';
import type { GrnData, SystemGrn, Reconciliation } from './grn-types';
import { periodBounds, validDate } from './validation';

type Grain = { po_detail_id: string | null; po_number: string; sku: string | null; size: string | null };
const norm = (value: string | null | undefined) => (value ?? '').trim().toUpperCase() || null;
export const grainKey = (row: Grain) => JSON.stringify([
  (row.po_detail_id ?? '').trim(), row.po_number.trim(), norm(row.sku), norm(row.size),
]);
export const productGrainKey = (row: { po_number: string; product_code?: string | null }) => JSON.stringify(['product', row.po_number.trim(), row.product_code]);
export const matchesPlanSource = (line: PlanLine, receipt: SystemGrn) => line.planning_level === 'product'
  ? !!receipt.product_code && line.po_number.trim() === receipt.po_number.trim() && line.product_code === receipt.product_code
  : grainKey(line) === grainKey(receipt);
// Quantities use integer thousandths so decimal receipts do not produce phantom shortfalls.
export function units(value: number | string): number {
  const result = Math.round(Number(value) * 1000);
  if (!Number.isFinite(Number(value)) || !Number.isSafeInteger(result) || result < 0 || Math.abs(Number(value) * 1000 - result) > 0.000001)
    throw new Error('Invalid or unsafe quantity in source data.');
  return result;
}
const qty = (value: number) => value / 1000;
const sum = (a: number, b: number) => {
  if (!Number.isSafeInteger(a + b)) throw new Error('Quantity total exceeds safe precision.');
  return a + b;
};
export function uniqueReceipts(rows: SystemGrn[]): SystemGrn[] {
  const seen = new Map<string, SystemGrn>();
  for (const row of rows) {
    if (!/^[1-9][0-9]*$/.test(row.grn_detail_id) || !validDate(row.received_on) || row.received_qty == null)
      throw new Error('A system GRN is missing its detail reference, receipt date or quantity.');
    units(row.received_qty);
    const old = seen.get(row.grn_detail_id);
    if (old && (grainKey(old) !== grainKey(row) || old.received_on !== row.received_on || old.grn_id !== row.grn_id || old.product_code !== row.product_code ||
      units(old.received_qty) !== units(row.received_qty))) throw new Error('Conflicting copies of one system GRN detail. Reload after the source sync.');
    seen.set(row.grn_detail_id, row);
  }
  return [...seen.values()].sort((a, b) => a.received_on.localeCompare(b.received_on) || a.grn_detail_id.localeCompare(b.grn_detail_id));
}
export function reconciliationBalances(data: GrnData) {
  const receipts = new Map(uniqueReceipts(data.receipts).map(row => [row.grn_detail_id, row]));
  const reports = new Map(data.reports.map(row => [row.id, row]));
  const lines = new Map(data.lines.map(row => [row.id, row]));
  const remaining = new Map<string, number>();
  const effective = new Map<string, number>();
  const claimed = new Map<string, number>();
  const sourceClaimed = new Map<string, number>();
  const warnings: string[] = [];
  const active = data.reconciliations.filter(r => !r.reversed_at)
    .sort((a, b) => a.created_at.localeCompare(b.created_at) || a.id.localeCompare(b.id));
  for (const row of active) {
    const amount = units(row.quantity);
    claimed.set(row.tracker_id, sum(claimed.get(row.tracker_id) ?? 0, amount));
    sourceClaimed.set(row.grn_detail_id, sum(sourceClaimed.get(row.grn_detail_id) ?? 0, amount));
    const source = receipts.get(row.grn_detail_id);
    const report = reports.get(row.tracker_id);
    const line = report && lines.get(report.line_id);
    if (!source || !line || !report?.received_on || grainKey(row) !== grainKey(source) ||
      !matchesPlanSource(line, source) || source.received_on < report.received_on ||
      source.received_on !== row.system_received_on || source.grn_id !== row.grn_id) {
      warnings.push('Reconciliation ' + row.id + ' no longer agrees with the live GRN/line. Reverse and review it.');
      continue;
    }
    const available = remaining.get(source.grn_detail_id) ?? units(source.received_qty);
    const effectiveQty = Math.min(amount, available);
    remaining.set(source.grn_detail_id, available - effectiveQty);
    effective.set(report.id, sum(effective.get(report.id) ?? 0, effectiveQty));
    if (effectiveQty < amount) warnings.push('GRN detail ' + source.grn_detail_id + ' has less live quantity than its reconciliations. Review the allocations.');
  }
  const awaiting = new Map(data.reports.map(report => [report.id,
    qty(Math.max(0, units(report.reported_qty) - (effective.get(report.id) ?? 0)))]));
  return { awaiting, effective: new Map([...effective].map(([id, value]) => [id, qty(value)])),
    claimed: new Map([...claimed].map(([id, value]) => [id, qty(value)])),
    sourceClaimed: new Map([...sourceClaimed].map(([id, value]) => [id, qty(value)])), warnings };
}
export type MetricRow = {
  key: string; product_code?: string; planning_level?: 'sku' | 'product'; po_detail_id: string | null; po_number: string; sku: string | null; size: string | null;
  planned: number; actual: number; achievement: number | null; shortfall: number;
  late: number; lateAfterPeriod: number; awaiting: number; unallocated: number;
  references: SystemGrn[];
};
export function calculateAnalytics(data: GrnData, cadence: PeriodKind, start: string, asOf: string) {
  if (!validDate(asOf)) throw new Error('Invalid as-of date.');
  const bounds = periodBounds(cadence, start);
  // Cadences are alternative baselines. There is intentionally no "all" mode.
  const plans = new Map(data.plans.filter(p => p.status === 'approved' && p.period_kind === cadence).map(p => [p.id, p]));
  const allLines = data.lines.filter(line => plans.has(line.plan_id));
  const productGrains = new Set(allLines.filter(line => line.planning_level === 'product').map(productGrainKey));
  const planningKey = (row: PlanLine | SystemGrn) => productGrains.has(productGrainKey(row)) ? productGrainKey(row) : grainKey(row);
  const selected = allLines.filter(line => plans.get(line.plan_id)?.period_start === start);
  const selectedIds = new Set(selected.map(line => line.id));
  const groups = new Map<string, MetricRow>();
  for (const line of selected) {
    const key = planningKey(line);
    const row = groups.get(key) ?? { key, product_code: line.product_code, planning_level: productGrains.has(productGrainKey(line)) ? 'product' as const : 'sku' as const, po_detail_id: line.po_detail_id, po_number: line.po_number,
      sku: line.sku, size: line.size, planned: 0, actual: 0, achievement: null, shortfall: 0,
      late: 0, lateAfterPeriod: 0, awaiting: 0, unallocated: 0, references: [] };
    row.planned = sum(row.planned, units(line.inward_qty)); groups.set(key, row);
  }
  const balances = reconciliationBalances(data);
  for (const report of data.reports) {
    const line = selected.find(l => l.id === report.line_id);
    if (line) {
      const row = groups.get(planningKey(line))!;
      row.awaiting = sum(row.awaiting, units(balances.awaiting.get(report.id) ?? 0));
    }
  }
  const schedules = new Map<string, { line: PlanLine; remaining: number }[]>();
  for (const line of allLines.sort((a, b) => a.expected_date.localeCompare(b.expected_date) || a.id.localeCompare(b.id))) {
    const key = planningKey(line);
    const list = schedules.get(key) ?? []; list.push({ line, remaining: units(line.inward_qty) }); schedules.set(key, list);
  }
  const daily = new Map<string, { planned: number; actual: number }>();
  for (const line of selected) {
    const day = daily.get(line.expected_date) ?? { planned: 0, actual: 0 };
    day.planned = sum(day.planned, units(line.inward_qty)); daily.set(line.expected_date, day);
  }
  // One receipt ledger per cadence. A repeated PO/SKU schedule never multiplies a GRN.
  for (const receipt of uniqueReceipts(data.receipts).filter(r => r.received_on <= asOf)) {
    const key = planningKey(receipt);
    const row = groups.get(key);
    const inPeriod = receipt.received_on >= start && receipt.received_on <= bounds.end;
    let remaining = units(receipt.received_qty);
    if (row && inPeriod) {
      row.actual = sum(row.actual, remaining); row.references.push(receipt);
      const day = daily.get(receipt.received_on) ?? { planned: 0, actual: 0 };
      day.actual = sum(day.actual, remaining); daily.set(receipt.received_on, day);
    }
    for (const schedule of schedules.get(key) ?? []) {
      if (!remaining) break;
      if (receipt.received_on < plans.get(schedule.line.plan_id)!.period_start) continue;
      const allocated = Math.min(remaining, schedule.remaining);
      schedule.remaining -= allocated; remaining -= allocated;
      if (allocated > 0 && row && receipt.received_on > schedule.line.expected_date) {
        if (inPeriod) row.late = sum(row.late, allocated);
        else if (selectedIds.has(schedule.line.id) && receipt.received_on > bounds.end) {
          row.lateAfterPeriod = sum(row.lateAfterPeriod, allocated); row.references.push(receipt);
        }
      }
    }
    if (row && inPeriod) row.unallocated = sum(row.unallocated, remaining);
  }
  const rows = [...groups.values()].map(row => ({
    ...row, planned: qty(row.planned), actual: qty(row.actual), shortfall: qty(Math.max(0, row.planned - row.actual)),
    achievement: row.planned ? row.actual / row.planned * 100 : null,
    late: qty(row.late), lateAfterPeriod: qty(row.lateAfterPeriod), awaiting: qty(row.awaiting),
    unallocated: qty(row.unallocated), references: uniqueReceipts(row.references),
  })).sort((a, b) => a.po_number.localeCompare(b.po_number) || (a.sku ?? '').localeCompare(b.sku ?? '') || (a.po_detail_id ?? '').localeCompare(b.po_detail_id ?? ''));
  const total = (field: 'planned' | 'actual' | 'shortfall' | 'late' | 'lateAfterPeriod' | 'awaiting' | 'unallocated') =>
    qty(rows.reduce((result, row) => sum(result, units(row[field])), 0));
  const planned = total('planned'); const actual = total('actual');
  return { rows, start, end: bounds.end, asOf, cadence, planned, actual,
    achievement: planned ? actual / planned * 100 : null, shortfall: total('shortfall'),
    late: total('late'), lateAfterPeriod: total('lateAfterPeriod'), awaiting: total('awaiting'),
    warnings: balances.warnings,
    daily: [...daily].sort(([a], [b]) => a.localeCompare(b)).map(([date, day]) => ({ date, planned: qty(day.planned), actual: qty(day.actual) })),
  };
}
export function matchingGrns(line: PlanLine, reportDate: string | null, receipts: SystemGrn[]) {
  return uniqueReceipts(receipts).filter(row => matchesPlanSource(line, row) &&
    (!reportDate || row.received_on >= reportDate) && units(row.received_qty) > 0);
}
export const activeReconciliations = (rows: Reconciliation[], trackerId: string) =>
  rows.filter(r => r.tracker_id === trackerId && !r.reversed_at);
