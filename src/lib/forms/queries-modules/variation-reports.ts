import 'server-only';
import { client, pageAll } from './_shared';
import { loadBuyingPlanAnalysis } from './buying-plan-analysis';
import { addMonths, monthLabel } from '../approval';
import type { BuyingPlanLine, StandardCost } from '../types';
import type { InwardPlanSheetRow } from './inward-plan-sheet';
import type { VariationReport, VariationRow } from '@/lib/variation-report';

/*
 * Server builders for the Variation Report of a closed document (see src/lib/variation-report.ts).
 * Each one only reads what the page already treats as the plan and the actual.
 */

const day = (iso: string) =>
  new Date(iso.length === 10 ? `${iso}T00:00:00Z` : iso).toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: 'numeric', timeZone: iso.length === 10 ? 'UTC' : 'Asia/Kolkata' });
const now = () => new Date().toISOString();
const ym = (month: string) => month.slice(0, 7);

/** Buying Plan (Finished Goods), a month that is over: approved plan vs POs issued in it. */
export async function buyingPlanVariation(planMonth: string): Promise<VariationReport> {
  const a = await loadBuyingPlanAnalysis(planMonth);
  const m = a.metrics;
  const products: VariationRow[] = a.products
    .filter((p) => p.plannedQty > 0 || p.issuedQty > 0)
    .sort((x, y) => Math.abs(y.deltaQty) - Math.abs(x.deltaQty) || x.product_code.localeCompare(y.product_code))
    .map((p) => ({
      key: p.product_code,
      name: p.product_code,
      sub: p.poCount ? `${p.poCount} PO${p.poCount === 1 ? '' : 's'}` : null,
      planned: p.plannedQty,
      actual: p.issuedQty,
      note: p.status === 'not_approved' ? 'in the plan, never approved' : null,
    }));
  const values: VariationRow[] = a.products
    .filter((p) => p.plannedValue > 0 || p.issuedValue > 0)
    .sort((x, y) => Math.abs(y.deltaValue) - Math.abs(x.deltaValue))
    .map((p) => ({ key: p.product_code, name: p.product_code, planned: p.plannedValue, actual: p.issuedValue }));
  return {
    title: `Buying Plan · Finished Goods · ${monthLabel(planMonth)}`,
    period: monthLabel(planMonth),
    closedNote: `Month closed on ${day(addMonths(planMonth, 1))}`,
    basis: [
      'Planned = approved plan lines only (Job Work + FOB + E-FOB quantity); value = the line value frozen when the plan was submitted.',
      'Actual = EasyEcom POs issued in the month (SAADAA warehouse, approved or completed), by PO date; value = quantity × PO item price.',
      `${a.approvedLines} of ${a.totalLines} plan lines were approved.`,
    ],
    tiles: [
      { label: 'Quantity (pcs)', planned: m.plannedQty, actual: m.issuedQty, unit: 'pcs' },
      { label: 'Value', planned: m.plannedValue, actual: m.issuedValue, unit: 'inr' },
      { label: 'POs', planned: m.plannedPoCount, actual: m.actualPoCount, unit: 'pcs' },
    ],
    sections: [
      { title: 'Quantity by product', unit: 'pcs', plannedLabel: 'Approved', actualLabel: 'Issued', rows: products, empty: a.hasPlan ? 'Nothing approved or issued this month.' : 'There was no plan for this month.' },
      { title: 'Value by product', unit: 'inr', plannedLabel: 'Approved', actualLabel: 'Issued', rows: values },
    ],
    missing: a.hasPlan ? null : 'There was no Finished Goods plan for this month, so every PO issued in it shows as not planned.',
    generatedAt: now(),
    fileName: `variation-buying-plan-fg-${ym(planMonth)}`,
  };
}

/** Buying Plan (Fabric / Material), a month that is over. No material POs reach the dashboard. */
export function materialPlanVariation(planMonth: string, lines: BuyingPlanLine[]): VariationReport {
  const approved = lines.filter((l) => l.line_status === 'approved');
  const rows: VariationRow[] = approved
    .map((l) => ({
      key: String(l.id),
      name: l.product_code,
      sub: [l.material_type, l.colour, l.uom].filter(Boolean).join(' · ') || null,
      planned: (Number(l.job_work_qty) || 0) + (Number(l.fob_qty) || 0) + (Number(l.efob_qty) || 0),
      actual: null,
    }))
    .sort((x, y) => (y.planned ?? 0) - (x.planned ?? 0));
  return {
    title: `Buying Plan · Fabric / Material · ${monthLabel(planMonth)}`,
    period: monthLabel(planMonth),
    closedNote: `Month closed on ${day(addMonths(planMonth, 1))}`,
    basis: [
      'Planned = approved material plan lines (Job Work + Purchase quantity, in each line’s unit).',
      `${approved.length} of ${lines.length} plan lines were approved.`,
    ],
    tiles: [{ label: 'Approved quantity', planned: rows.reduce((t, r) => t + (r.planned ?? 0), 0), actual: null, unit: 'pcs' }],
    sections: [{ title: 'Approved lines', unit: 'pcs', plannedLabel: 'Approved', actualLabel: 'Issued', rows, empty: 'No approved material lines this month.' }],
    missing: 'Actual is not available: material POs are not in the EasyEcom feed the dashboard reads, so issued quantity cannot be compared yet.',
    generatedAt: now(),
    fileName: `variation-buying-plan-material-${ym(planMonth)}`,
  };
}

type PoLine = { po_ref_num: string | null; po_number: string | null; po_date: string | null; vendor_name: string | null; original_qty: number | null; item_price: number | null };

/** Standard Cost, frozen (a PO was issued against it): standard rate vs the PO line prices. */
export async function standardCostVariation(cost: StandardCost): Promise<VariationReport> {
  const supabase = await client();
  const code = cost.product_code.trim().toUpperCase();
  const lines = await pageAll<PoLine>(() =>
    supabase
      .from('sd_po_filtered')
      .select('po_ref_num, po_number, po_date, vendor_name, original_qty, item_price')
      .eq('product_code', code)
      .in('po_status_code', [3, 5])
      .order('po_detail_id'),
  );
  const typeOf = (ref: string | null) => String(ref ?? '').split('/')[1]?.trim().toUpperCase() ?? '';
  const std: Record<string, number | null> = {
    JOB: cost.job_cost == null ? null : Number(cost.job_cost),
    FOB: cost.fob_cost == null ? null : Number(cost.fob_cost),
    EFOB: cost.efob_cost == null ? null : Number(cost.efob_cost),
  };
  const label: Record<string, string> = { JOB: 'Job', FOB: 'FOB', EFOB: 'E-FOB' };

  // One row per PO: quantity-weighted price across its SKU lines.
  type Po = { ref: string; number: string | null; date: string | null; vendor: string | null; type: string; qty: number; value: number };
  const pos = new Map<string, Po>();
  for (const l of lines) {
    const ref = l.po_ref_num ?? l.po_number ?? '';
    const qty = Number(l.original_qty) || 0;
    const price = Number(l.item_price);
    if (!ref || !Number.isFinite(price)) continue;
    const p = pos.get(ref) ?? { ref, number: l.po_number, date: l.po_date, vendor: l.vendor_name, type: typeOf(l.po_ref_num), qty: 0, value: 0 };
    p.qty += qty;
    p.value += qty * price;
    pos.set(ref, p);
  }
  const poList = Array.from(pos.values()).sort((a, b) => String(b.date ?? '').localeCompare(String(a.date ?? '')));
  const avg = (p: { qty: number; value: number }) => (p.qty > 0 ? p.value / p.qty : null);

  const byType = (['JOB', 'FOB', 'EFOB'] as const).map((t) => {
    const of = poList.filter((p) => p.type === t);
    const qty = of.reduce((s, p) => s + p.qty, 0);
    const value = of.reduce((s, p) => s + p.value, 0);
    return { t, of, qty, actual: qty > 0 ? value / qty : null };
  });

  return {
    title: `Standard Cost · ${cost.product_code}`,
    period: cost.product_code,
    closedNote: cost.frozen_at ? `Frozen on ${day(cost.frozen_at)} (PO issued)` : 'Frozen (PO issued)',
    basis: [
      'Planned = the standard rate on file for each PO type (Job / FOB / E-FOB).',
      'Actual = the price on the EasyEcom PO lines for this product (SAADAA warehouse, approved or completed), quantity-weighted per PO and per type.',
      'Above standard = the PO paid more than the standard rate.',
    ],
    tiles: byType
      .filter((b) => std[b.t] != null || b.actual != null)
      .map((b) => ({ label: `${label[b.t]} rate`, planned: std[b.t], actual: b.actual, unit: 'rate' as const })),
    sections: [
      {
        title: 'Rate by PO type',
        unit: 'rate',
        plannedLabel: 'Standard',
        actualLabel: 'PO average',
        words: { over: 'Above standard', short: 'Below standard', onPlan: 'At standard', unplanned: 'No standard' },
        rows: byType.map((b) => ({
          key: b.t,
          name: label[b.t],
          sub: b.of.length ? `${b.of.length} PO${b.of.length === 1 ? '' : 's'} · ${new Intl.NumberFormat('en-IN').format(b.qty)} pcs` : 'no PO of this type',
          planned: std[b.t],
          actual: b.actual,
        })),
      },
      {
        title: 'Each PO',
        unit: 'rate',
        plannedLabel: 'Standard',
        actualLabel: 'PO price',
        words: { over: 'Above standard', short: 'Below standard', onPlan: 'At standard', unplanned: 'No standard' },
        rows: poList.map((p) => ({
          key: p.ref,
          name: p.number ?? p.ref,
          sub: [label[p.type] ?? (p.type || null), p.vendor, p.date ? day(p.date.slice(0, 10)) : null, `${new Intl.NumberFormat('en-IN').format(p.qty)} pcs`].filter(Boolean).join(' · '),
          planned: std[p.type] ?? null,
          actual: avg(p),
        })),
        empty: 'No approved or completed EasyEcom PO carries this product yet.',
      },
    ],
    missing: poList.length ? null : 'No approved or completed EasyEcom PO for this product has reached the dashboard yet, so there is no actual price to compare.',
    generatedAt: now(),
    fileName: `variation-standard-cost-${cost.product_code}`,
  };
}

/** Vendor Capacity, a past week: PO capacity vs quantity on order at the end of the week. */
export function vendorCapacityVariation(
  week: { week: string; label: string; inProcessKept: boolean },
  vendors: { code: string; name: string | null; type: string | null; poCapacity: number | null; onOrder: number }[],
): VariationReport {
  const rows: VariationRow[] = vendors
    .filter((v) => (v.poCapacity ?? 0) > 0 || v.onOrder > 0)
    .map((v) => ({ key: v.code, name: v.name || v.code, sub: [v.code, v.type].filter(Boolean).join(' · '), planned: v.poCapacity, actual: v.onOrder }))
    .sort((a, b) => (b.actual ?? 0) / Math.max(1, b.planned ?? 0) - (a.actual ?? 0) / Math.max(1, a.planned ?? 0));
  const cap = rows.reduce((t, r) => t + (r.planned ?? 0), 0);
  const ord = rows.reduce((t, r) => t + (r.actual ?? 0), 0);
  const noCap = rows.filter((r) => !r.planned).length;
  return {
    title: `Vendor Capacity · ${week.label}`,
    period: week.label,
    closedNote: 'Week closed',
    basis: [
      'Planned = PO capacity: the capacity each vendor had declared by the end of the week, over its PO type’s lead time (same calculation as the capacity sheet).',
      week.inProcessKept
        ? 'Actual = quantity on order with the vendor at the end of the week (weekly copy).'
        : 'Actual = quantity on order today — no weekly copy was kept for this week, so the end-of-week figure is not available.',
      'Capacity used is written as “100% Over Utilised” once a vendor is past capacity.',
      ...(noCap ? [`${noCap} vendor${noCap === 1 ? ' has' : 's have'} quantity on order but no capacity entered.`] : []),
    ],
    tiles: [{ label: 'Capacity vs on order (pcs)', planned: cap, actual: ord, unit: 'pcs', pctMode: 'utilisation' }],
    sections: [
      {
        title: 'By vendor',
        unit: 'pcs',
        plannedLabel: 'PO capacity',
        actualLabel: 'On order',
        pctMode: 'utilisation',
        words: { over: 'Over capacity', short: 'Within capacity', onPlan: 'At capacity', unplanned: 'No capacity entered' },
        rows,
        empty: 'No vendor had capacity or quantity on order this week.',
      },
    ],
    missing: null,
    generatedAt: now(),
    fileName: `variation-vendor-capacity-${week.week}`,
  };
}

/** Inward Plan, a month that is over: approved inward quantity vs GRN received in the month. */
export function inwardPlanVariation(month: string, sheet: InwardPlanSheetRow[]): VariationReport {
  const ofMonth = sheet.filter((r) => r.plan_month === month && !/reject/i.test(r.approval_status));
  const approved = ofMonth.filter((r) => /approved/i.test(r.approval_status));
  const notApproved = ofMonth.length - approved.length;
  const rows: VariationRow[] = approved
    .map((r) => ({
      key: String(r.id),
      name: r.po_no ?? r.product_code,
      sub: [r.product_code, r.po_type, r.vendor_name].filter(Boolean).join(' · '),
      planned: r.inward_qty,
      actual: r.received_in_month,
    }))
    .sort((a, b) => Math.abs((b.actual ?? 0) - (b.planned ?? 0)) - Math.abs((a.actual ?? 0) - (a.planned ?? 0)));
  const byVendor = new Map<string, { planned: number; actual: number }>();
  for (const r of approved) {
    const k = r.vendor_name || 'Vendor not on the PO';
    const v = byVendor.get(k) ?? { planned: 0, actual: 0 };
    v.planned += Number(r.inward_qty) || 0;
    v.actual += r.received_in_month;
    byVendor.set(k, v);
  }
  const planned = approved.reduce((t, r) => t + (Number(r.inward_qty) || 0), 0);
  const actual = approved.reduce((t, r) => t + r.received_in_month, 0);
  const pValue = approved.reduce((t, r) => t + (Number(r.inward_qty) || 0) * (Number(r.cost_per_piece) || 0), 0);
  const aValue = approved.reduce((t, r) => t + r.received_in_month * (Number(r.cost_per_piece) || 0), 0);
  return {
    title: `Inward Plan · ${monthLabel(month)}`,
    period: monthLabel(month),
    closedNote: `Month closed on ${day(addMonths(month, 1))}`,
    basis: [
      'Planned = approved inward plan lines for the month (pieces; value at the line’s cost per piece).',
      'Actual = GRN pieces received in the month against each line’s PO (SAADAA warehouse).',
      ...(notApproved ? [`${notApproved} line${notApproved === 1 ? ' was' : 's were'} never approved and ${notApproved === 1 ? 'is' : 'are'} left out.`] : []),
    ],
    tiles: [
      { label: 'Pieces', planned, actual, unit: 'pcs' },
      { label: 'Value', planned: pValue, actual: aValue, unit: 'inr' },
    ],
    sections: [
      { title: 'By PO line', unit: 'pcs', plannedLabel: 'Planned', actualLabel: 'Received', rows, empty: 'No approved inward plan lines this month.' },
      {
        title: 'By vendor',
        unit: 'pcs',
        plannedLabel: 'Planned',
        actualLabel: 'Received',
        rows: Array.from(byVendor, ([name, v]) => ({ key: name, name, planned: v.planned, actual: v.actual })).sort((a, b) => b.planned - a.planned),
      },
    ],
    missing: approved.length ? null : 'No inward plan line was approved for this month, so there is nothing planned to compare the receipts against.',
    generatedAt: now(),
    fileName: `variation-inward-plan-${ym(month)}`,
  };
}
