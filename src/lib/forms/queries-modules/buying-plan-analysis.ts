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
import { ANALYTICS_RULE_DEFAULTS } from './analytics';
import { addMonths, isPlanFrozen, monthStart, planComplianceStatus } from '../approval';
import { slackReportTarget } from '@/lib/slack';
import type { BuyingPlan, BuyingPlanLine } from '../types';
import type {
  BuyingPlanAnalysis,
  BuyingPlanAnalysisPo,
  BuyingPlanAnalysisProduct,
  BuyingPlanLifecycle,
} from '../analysis-types';

/** The Supabase client the loader reads with (session-bound by default; the month-close
 *  cron passes the service-role client because it runs with no user session). */
export type AnalysisDb = Awaited<ReturnType<typeof client>>;

const normCode = (code: string | null | undefined) => String(code ?? '').trim().toUpperCase();

// PO reference = FY../<TYPE>/<PRODUCT>/<VENDOR>-<SEQ>; the PO type is the 2nd segment.
const poTypeOfRef = (ref: string | null) => {
  const t = String(ref ?? '').split('/')[1];
  return t ? t.trim().toUpperCase() : null;
};

// standard_value on a submitted/approved FG line is the line's FROZEN TOTAL value (qty × rate
// at submit — e.g. SUZNS Aug-26: qty 3,925 × ₹500 = 1,962,500 is what is stored), whereas an
// unsubmitted line may still carry the per-unit rate. A total is never smaller than the
// quantity (that would mean a rate under ₹1), so: value ≥ qty ⇒ already a total; otherwise it
// is a per-unit rate and we multiply. Zero quantity carries no value regardless.
const lineValue = (qty: number, sv: number) => (qty > 0 ? (sv >= qty ? sv : qty * sv) : 0);

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

export async function loadBuyingPlanAnalysis(planMonth = monthStart(), db?: AnalysisDb): Promise<BuyingPlanAnalysis> {
  const supabase = db ?? (await client());

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
      value: prev.value + (approved ? lineValue(qty, Number(l.standard_value || 0)) : 0),
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

  // A line "carries a budget" only when it is approved AND has a quantity. An approved
  // line with zero qty authorises nothing, so anything issued against it is "not
  // budgeted" (exception a), not "issued above approved" (exception b) — otherwise
  // "approved 0, issued 500" would masquerade as an over-issue.
  const hasBudget = (p: Planned | undefined) => Boolean(p?.approved) && (p?.qty ?? 0) > 0;

  // Per-product rows = budgeted-plan products ∪ issued products.
  const codes = new Set<string>();
  for (const [code, p] of planned) if (hasBudget(p)) codes.add(code);
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
    const pApproved = hasBudget(p);
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

  // ---- Month-end lifecycle (spec item 5): freeze, approval deadline, approval quality,
  // trailing first-time-approval rate, and the latest generated month report. ----
  const planX = planRow as (BuyingPlan & { amended_after_freeze?: boolean | null }) | null;
  const { data: ruleRow } = await supabase
    .from('sd_analytics_rule')
    .select('value')
    .eq('rule_key', 'plan_approval_deadline_day')
    .maybeSingle();
  const deadlineDay = Math.max(
    1,
    Math.min(28, Math.round(Number(ruleRow?.value ?? ANALYTICS_RULE_DEFAULTS.plan_approval_deadline_day ?? 7))),
  );
  const frozen = isPlanFrozen(planMonth);
  // The deadline measures the first ADMIN DECISION (approve / reject / rework), not
  // approval alone — a rejection or rework by the 7th is action taken in time.
  const firstActionAt = plan ? await loadPlanFirstActionAt(plan.id, supabase) : null;
  const compliance = planComplianceStatus(
    plan ? { submitted_at: plan.submitted_at, approved_at: plan.approved_at, action_at: firstActionAt } : null,
    planMonth,
    deadlineDay,
  );
  const approvalKind: BuyingPlanLifecycle['approvalKind'] =
    !plan || plan.status !== 'approved'
      ? 'not_approved'
      : planX?.amended_after_freeze
        ? 'amended_after_freeze'
        : plan.edited_before_approval
          ? 'edited'
          : 'first_time';
  // First-time approval rate over the trailing six FG plans (this month included):
  // approved plans that were never sent to rework nor amended after approval.
  const { data: hist } = await supabase
    .from('sd_buying_plan')
    .select('plan_month, status, edited_before_approval, amended_after_freeze')
    .eq('plan_type', 'fg')
    .gte('plan_month', addMonths(planMonth, -5))
    .lte('plan_month', planMonth)
    .order('plan_month');
  const approvedPlans = ((hist ?? []) as { plan_month: string; status: string; edited_before_approval: boolean | null; amended_after_freeze: boolean | null }[])
    .filter((h) => h.status === 'approved');
  const firstTimeRate = {
    firstTime: approvedPlans.filter((h) => !h.edited_before_approval && !h.amended_after_freeze).length,
    approved: approvedPlans.length,
    months: approvedPlans.map((h) => String(h.plan_month).slice(0, 7)),
  };
  const { data: rep } = await supabase
    .from('sd_plan_report')
    .select('generated_at, generated_by, slack_posted_at, slack_error, storage_path')
    .eq('plan_month', planMonth)
    .eq('plan_type', 'fg')
    .maybeSingle();
  const lifecycle: BuyingPlanLifecycle = {
    frozen,
    frozenSince: frozen ? addMonths(planMonth, 1) : null,
    submittedAt: plan?.submitted_at ?? null,
    approvedAt: plan?.approved_at ?? null,
    firstActionAt,
    slackTarget: slackReportTarget(),
    compliance: { deadline: compliance.deadline, deadlineDay, status: compliance.status, daysLate: compliance.daysLate },
    approvalKind,
    firstTimeRate,
    report: rep
      ? {
          generatedAt: String(rep.generated_at),
          generatedBy: (rep.generated_by as string | null) ?? null,
          slackPostedAt: (rep.slack_posted_at as string | null) ?? null,
          slackError: (rep.slack_error as string | null) ?? null,
          storagePath: String(rep.storage_path),
        }
      : null,
  };

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
    lifecycle,
  };
}

/**
 * When did an admin first ACT on this plan (approve / reject / send for rework)? From the
 * approval log — the plan row itself only stamps approved_at. Null when no decision yet.
 */
export async function loadPlanFirstActionAt(planId: number, db?: AnalysisDb): Promise<string | null> {
  const supabase = db ?? (await client());
  const { data } = await supabase
    .from('sd_approval_log')
    .select('created_at')
    .eq('entity_type', 'buying_plan')
    .eq('entity_id', String(planId))
    .in('to_status', ['approved', 'rejected', 'rework'])
    .order('created_at', { ascending: true })
    .limit(1)
    .maybeSingle();
  return data?.created_at ? String(data.created_at) : null;
}
