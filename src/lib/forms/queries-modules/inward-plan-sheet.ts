import 'server-only';
import { client, pageAll } from './_shared';
import { loadProductCatalog } from './product';

/**
 * One line of the team's monthly inward-plan sheet (sd_inward_plan_entry), with
 * what has actually been received against it. The sheet is one row per PO ×
 * product (no colour split), so receipts are matched on the PO reference.
 */
export type InwardPlanSheetRow = {
  id: number;
  plan_month: string; // YYYY-MM-01
  product_code: string;
  category: string | null;
  po_no: string | null;
  /** JOB / FOB / EFOB, read off the PO reference (FY26-27/EFOB/…); null when unreadable. */
  po_type: string | null;
  vendor_name: string | null;
  inward_qty: number | null;
  cost_per_piece: number | null;
  /** inward_qty × cost_per_piece — never stored. */
  value: number;
  remarks: string | null;
  mt_comments: string | null;
  approval_status: string; // Pending / Approved / RE-WORK / Rejected
  /** The approver changed this line when approving (Edit & approve). */
  approver_edited: boolean;
  /** GRN pieces for this PO ref dated inside the plan month. */
  received_in_month: number;
  /** GRN pieces for this PO ref, any date. */
  received_total: number;
  last_received_on: string | null;
  /** GRN pieces for this PO ref by receipt day (YYYY-MM-DD), days inside the plan month only. */
  received_by_day: Record<string, number>;
  /** received_in_month − inward_qty; null when no planned qty. */
  variance: number | null;
  created_by: string | null;
  created_at: string;
  updated_by: string | null;
  updated_at: string;
};

const nextMonth = (month: string) => {
  const d = new Date(`${month}T00:00:00Z`);
  d.setUTCMonth(d.getUTCMonth() + 1);
  return d.toISOString().slice(0, 10);
};

const poTypeOf = (ref: string | null): string | null => {
  const m = (ref ?? '').toUpperCase().match(/\/(JOB|FOB|EFOB|E-FOB)\//);
  return m ? m[1].replace('E-FOB', 'EFOB') : null;
};

export async function loadInwardPlanSheet(): Promise<InwardPlanSheetRow[]> {
  const supabase = await client();
  const rows = await pageAll<Record<string, unknown>>(() =>
    supabase
      .from('sd_inward_plan_entry')
      .select('id, plan_month, product_code, po_no, vendor_name, inward_qty, cost_per_piece, remarks, mt_comments, approval_status, approver_edited, created_by, created_at, updated_by, updated_at')
      .order('plan_month', { ascending: false })
      .order('id'),
  );
  if (!rows.length) return [];

  const catalog = await loadProductCatalog();
  const catByCode = new Map(catalog.map((c) => [c.product_code, c.category] as const));

  // Receipts by PO reference, keyed by month of receipt as well as in total.
  const refs = [...new Set(rows.map((r) => String(r.po_no ?? '').trim()).filter(Boolean))];
  const grn = new Map<string, { total: number; byMonth: Map<string, number>; byDay: Map<string, number>; last: string | null }>();
  for (let i = 0; i < refs.length; i += 200) {
    const chunk = refs.slice(i, i + 200);
    const data = await pageAll<{ po_ref_num: string; received_quantity: number | null; grn_created_at: string | null }>(() =>
      supabase
        .from('sd_ee_grn_saadaa')
        .select('po_ref_num, received_quantity, grn_created_at')
        .in('po_ref_num', chunk)
        .order('po_ref_num')
        .order('grn_detail_id'),
    );
    for (const g of data) {
      const ref = String(g.po_ref_num ?? '').trim();
      if (!ref) continue;
      const agg = grn.get(ref) ?? { total: 0, byMonth: new Map<string, number>(), byDay: new Map<string, number>(), last: null };
      const qty = Number(g.received_quantity) || 0;
      agg.total += qty;
      if (g.grn_created_at) {
        const m = `${g.grn_created_at.slice(0, 7)}-01`;
        agg.byMonth.set(m, (agg.byMonth.get(m) ?? 0) + qty);
        const d = g.grn_created_at.slice(0, 10);
        agg.byDay.set(d, (agg.byDay.get(d) ?? 0) + qty);
        if (!agg.last || g.grn_created_at > agg.last) agg.last = g.grn_created_at;
      }
      grn.set(ref, agg);
    }
  }

  return rows.map((r) => {
    const ref = String(r.po_no ?? '').trim() || null;
    const month = String(r.plan_month);
    const qty = r.inward_qty != null ? Number(r.inward_qty) || 0 : null;
    const cost = r.cost_per_piece != null ? Number(r.cost_per_piece) || 0 : null;
    const g = ref ? grn.get(ref) : undefined;
    const inMonth = g?.byMonth.get(month) ?? 0;
    const code = String(r.product_code ?? '');
    return {
      id: Number(r.id),
      plan_month: month,
      product_code: code,
      category: catByCode.get(code) ?? null,
      po_no: ref,
      po_type: poTypeOf(ref),
      vendor_name: (r.vendor_name as string | null) ?? null,
      inward_qty: qty,
      cost_per_piece: cost,
      value: (qty ?? 0) * (cost ?? 0),
      remarks: (r.remarks as string | null) ?? null,
      mt_comments: (r.mt_comments as string | null) ?? null,
      approval_status: String(r.approval_status ?? 'Pending'),
      approver_edited: Boolean(r.approver_edited),
      received_in_month: inMonth,
      received_total: g?.total ?? 0,
      last_received_on: g?.last ?? null,
      received_by_day: Object.fromEntries([...(g?.byDay ?? [])].filter(([d]) => d.slice(0, 7) === month.slice(0, 7))),
      variance: qty != null ? inMonth - qty : null,
      created_by: (r.created_by as string | null) ?? null,
      created_at: String(r.created_at),
      updated_by: (r.updated_by as string | null) ?? null,
      updated_at: String(r.updated_at),
    };
  });
}

/** Months that exist on the sheet, newest first, plus this month and the next two. */
export function inwardPlanMonthOptions(rows: InwardPlanSheetRow[], today = new Date()): string[] {
  const set = new Set(rows.map((r) => r.plan_month));
  const base = new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), 1));
  for (let i = 0; i < 3; i++) {
    const d = new Date(base);
    d.setUTCMonth(d.getUTCMonth() + i);
    set.add(d.toISOString().slice(0, 10));
  }
  void nextMonth;
  return [...set].sort().reverse();
}
