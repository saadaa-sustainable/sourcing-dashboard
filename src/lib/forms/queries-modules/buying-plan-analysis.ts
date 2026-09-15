import 'server-only';
// Buying Plan Analysis — month-filtered variance between the APPROVED finished-goods
// buying plan and the POs actually issued.
//
// Issued = sd_po_filtered rows with po_status_code 3/5 (issued / completed real EasyEcom
// POs) whose po_date falls in the month — the exact source and month rule behind
// sd_po_actuals_by_product_month, so these figures agree with the Buying Plan view.
// Planned = approved plan lines only (per-line approval, or the plan-level approval for
// legacy lines without one). Everything is derived at read time; nothing is stored.
//
// Exceptions: (a) products issued but NOT budgeted — absent from the plan, or present but
// never approved; (b) products issued ABOVE their approved quantity.

import { client, PAGE_SIZE } from './_shared';
import { monthStart } from '../approval';
import type { BuyingPlan, BuyingPlanLine } from '../types';
import type {
  BuyingPlanAnalysis,
  BuyingPlanAnalysisPo,
  BuyingPlanAnalysisProduct,
} from '../analysis-types';

const normCode = (code: string | null | undefined) => String(code ?? '').trim().toUpperCase();

// PO reference = FY../<TYPE>/<PRODUCT>/<VENDOR>-<SEQ>; the PO type is the 2nd segment.
const poTypeOfRef = (ref: string | null) => {
  const t = String(ref ?? '').split('/')[1];
  return t ? t.trim().toUpperCase() : null;
};

const nextMonthOf = (isoMonth: string) => {
  const [y, m] = isoMonth.split('-').map(Number);
  const ny = m === 12 ? y + 1 : y;
  const nm = m === 12 ? 1 : m + 1;
  return `${ny}-${String(nm).padStart(2, '0')}-01`;
};

type IssuedLine = {
  po_id: string | null;
  po_number: string | null;
  po_ref_num: string | null;
  product_code: string | null;
  vendor_code: string | null;
  vendor_name: string | null;
  original_qty: number | null;
  item_price: number | null;
  po_date: string | null;
};

export async function loadBuyingPlanAnalysis(planMonth = monthStart()): Promise<BuyingPlanAnalysis> {
  const supabase = await client();

  const { data: planRow } = await supabase
    .from('sd_buying_plan')
    .select('*')
    .eq('plan_month', planMonth)
    .eq('plan_type', 'fg')
    .maybeSingle();
  const plan = (planRow as BuyingPlan | null) ?? null;

  const lines: BuyingPlanLine[] = [];
  if (plan) {
    for (let from = 0; ; from += PAGE_SIZE) {
      const { data, error } = await supabase
        .from('sd_buying_plan_line')
        .select('*')
        .eq('plan_id', plan.id)
        .order('product_code')
        .range(from, from + PAGE_SIZE - 1);
      if (error) throw new Error(`sd_buying_plan_line: ${error.message}`);
      if (!data?.length) break;
      lines.push(...(data as BuyingPlanLine[]));
      if (data.length < PAGE_SIZE) break;
    }
  }

  const isApproved = (l: BuyingPlanLine) =>
    l.line_status === 'approved' || (plan?.status === 'approved' && l.line_status == null);

  // Planned, per product: approved quantity/value, and the number of product × PO-type
  // cells with a quantity (each such cell is one intended PO).
  type Planned = { qty: number; value: number; cells: number; approved: boolean };
  const planned = new Map<string, Planned>();
  let approvedLines = 0;
  for (const l of lines) {
    const code = normCode(l.product_code);
    if (!code) continue;
    const job = Number(l.job_work_qty || 0);
    const fob = Number(l.fob_qty || 0);
    const efob = Number(l.efob_qty || 0);
    const qty = job + fob + efob;
    const approved = isApproved(l);
    if (approved) approvedLines += 1;
    const prev = planned.get(code) ?? { qty: 0, value: 0, cells: 0, approved: false };
    planned.set(code, {
      approved: prev.approved || approved,
      qty: prev.qty + (approved ? qty : 0),
      value: prev.value + (approved ? qty * Number(l.standard_value || 0) : 0),
      cells: prev.cells + (approved ? [job, fob, efob].filter((q) => q > 0).length : 0),
    });
  }

  // Issued PO lines in the month (paged past the PostgREST cap).
  const issuedLines: IssuedLine[] = [];
  const monthEnd = nextMonthOf(planMonth);
  for (let from = 0; ; from += PAGE_SIZE) {
    const { data, error } = await supabase
      .from('sd_po_filtered')
      .select('po_id, po_number, po_ref_num, product_code, vendor_code, vendor_name, original_qty, item_price, po_date')
      .in('po_status_code', [3, 5])
      .gte('po_date', planMonth)
      .lt('po_date', monthEnd)
      .order('po_detail_id')
      .range(from, from + PAGE_SIZE - 1);
    if (error) throw new Error(`sd_po_filtered: ${error.message}`);
    if (!data?.length) break;
    issuedLines.push(...(data as IssuedLine[]));
    if (data.length < PAGE_SIZE) break;
  }

  type Issued = { qty: number; value: number; pos: Map<string, BuyingPlanAnalysisPo> };
  const issued = new Map<string, Issued>();
  const allPoIds = new Set<string>();
  for (const r of issuedLines) {
    const code = normCode(r.product_code);
    if (!code) continue;
    const qty = Number(r.original_qty) || 0;
    const value = qty * (Number(r.item_price) || 0);
    const poKey = String(r.po_id ?? r.po_number ?? r.po_ref_num ?? '').trim();
    if (poKey) allPoIds.add(poKey);
    const cur = issued.get(code) ?? { qty: 0, value: 0, pos: new Map<string, BuyingPlanAnalysisPo>() };
    cur.qty += qty;
    cur.value += value;
    if (poKey) {
      const po = cur.pos.get(poKey) ?? {
        po_id: poKey,
        po_number: r.po_number,
        po_ref_num: r.po_ref_num,
        po_type: poTypeOfRef(r.po_ref_num),
        vendor_code: r.vendor_code,
        vendor_name: r.vendor_name,
        po_date: r.po_date,
        qty: 0,
        value: 0,
      };
      po.qty += qty;
      po.value += value;
      cur.pos.set(poKey, po);
    }
    issued.set(code, cur);
  }

  // Per-product rows = approved-plan products ∪ issued products.
  const codes = new Set<string>();
  for (const [code, p] of planned) if (p.approved) codes.add(code);
  for (const code of issued.keys()) codes.add(code);

  const products: BuyingPlanAnalysisProduct[] = [];
  let plannedQty = 0;
  let plannedValue = 0;
  let plannedPoCount = 0;
  let issuedQty = 0;
  let issuedValue = 0;
  let excessQty = 0;
  let excessValue = 0;
  let shortQty = 0;
  let shortValue = 0;
  let approvedProducts = 0;
  for (const code of codes) {
    const p = planned.get(code);
    const i = issued.get(code);
    const pApproved = Boolean(p?.approved);
    const pq = pApproved ? p!.qty : 0;
    const pv = pApproved ? p!.value : 0;
    const iq = i?.qty ?? 0;
    const iv = i?.value ?? 0;
    let status: BuyingPlanAnalysisProduct['status'];
    if (!p) status = 'not_planned';
    else if (!pApproved) status = 'not_approved';
    else if (iq === 0) status = 'unissued';
    else if (iq > pq) status = 'over';
    else if (iq < pq) status = 'short';
    else status = 'on_plan';
    if (pApproved) {
      approvedProducts += 1;
      plannedQty += pq;
      plannedValue += pv;
      plannedPoCount += p!.cells;
      if (iq > pq) {
        excessQty += iq - pq;
        excessValue += Math.max(iv - pv, 0);
      } else if (iq < pq) {
        shortQty += pq - iq;
        shortValue += Math.max(pv - iv, 0);
      }
    }
    issuedQty += iq;
    issuedValue += iv;
    const pos = [...(i?.pos.values() ?? [])].sort((a, b) =>
      String(a.po_date ?? '').localeCompare(String(b.po_date ?? '')),
    );
    products.push({
      product_code: code,
      status,
      plannedQty: pq,
      plannedValue: pv,
      issuedQty: iq,
      issuedValue: iv,
      deltaQty: iq - pq,
      deltaValue: iv - pv,
      poCount: pos.length,
      pos,
    });
  }
  products.sort((a, b) => a.product_code.localeCompare(b.product_code));

  const pct = (n: number, den: number) => (den > 0 ? n / den : null);
  return {
    planMonth,
    hasPlan: Boolean(plan),
    planStatus: plan?.status ?? null,
    approvedLines,
    totalLines: lines.length,
    metrics: {
      plannedQty,
      issuedQty,
      qtyVarPct: pct(issuedQty - plannedQty, plannedQty),
      plannedValue,
      issuedValue,
      valueVarPct: pct(issuedValue - plannedValue, plannedValue),
      plannedPoCount,
      actualPoCount: allPoIds.size,
      excessQty,
      excessValue,
      excessPct: pct(excessQty, plannedQty),
      shortQty,
      shortValue,
      shortPct: pct(shortQty, plannedQty),
      approvedProducts,
      issuedProducts: issued.size,
    },
    products,
    exceptions: {
      notBudgeted: products
        .filter((r) => r.status === 'not_planned' || r.status === 'not_approved')
        .sort((a, b) => b.issuedQty - a.issuedQty),
      overApproved: products.filter((r) => r.status === 'over').sort((a, b) => b.deltaQty - a.deltaQty),
    },
  };
}
