import 'server-only';
import { client, PAGE_SIZE } from './_shared';
import { monthStart } from '../approval';
import { loadApprovedStandardCosts, loadApprovedMaterialCosts } from './standard-cost';
import { loadReplenishmentByProduct } from './replenishment-oos';
import type {
  BuyingPlan,
  BuyingPlanLine,
  BuyingPlanLineView,
  MaterialCode,
  Colour,
} from '../types';

/* ------------------------------------------------------------------ */
/* Buying plan                                                         */
/* ------------------------------------------------------------------ */

export async function loadBuyingPlan(planMonth = monthStart()) {
  const supabase = await client();

  const { data: plan } = await supabase
    .from('sd_buying_plan')
    .select('*')
    .eq('plan_month', planMonth)
    .eq('plan_type', 'fg')
    .maybeSingle();

  const lines: BuyingPlanLine[] = [];
  if (plan) {
    for (let from = 0; ; from += PAGE_SIZE) {
      const { data, error } = await supabase
        .from('sd_buying_plan_line')
        .select('*')
        .eq('plan_id', (plan as BuyingPlan).id)
        .order('product_code')
        .range(from, from + PAGE_SIZE - 1);
      if (error) throw new Error(`sd_buying_plan_line: ${error.message}`);
      if (!data?.length) break;
      lines.push(...(data as BuyingPlanLine[]));
      if (data.length < PAGE_SIZE) break;
    }
  }

  // Active variants only — the view already subtracts approved discontinues.
  const { data: variants } = await supabase
    .from('sd_active_variants')
    .select('product_code')
    .limit(PAGE_SIZE);

  const productCodes = [
    ...new Set(
      ((variants ?? []) as { product_code: string }[])
        .map((r) => r.product_code)
        .filter(Boolean),
    ),
  ].sort();

  // Product status + woven/knitted are derived from the EasyEcom product master (rolled
  // up to product code, normalised), read-only. The Buying Plan never lets these be typed.
  const { data: master } = await supabase
    .from('sd_ee_product_code_status')
    .select('product_code, product_status, fabric_type')
    .limit(PAGE_SIZE);

  const productMaster: Record<string, { status: string | null; fabric_type: string | null }> = {};
  (
    (master ?? []) as {
      product_code: string;
      product_status: string | null;
      fabric_type: string | null;
    }[]
  ).forEach((m) => {
    productMaster[m.product_code] = {
      status: m.product_status,
      fabric_type: m.fabric_type,
    };
  });

  // Discontinued products (per the master) must not appear in the plan's add-list.
  const activeCodes = productCodes.filter(
    (code) => productMaster[code]?.status !== 'Discontinued',
  );

  // Approved standard rates drive the per-PO-type buying value; the replenishment
  // roll-up drives the computed Pending Quantity (30-day ROP).
  const [standardCosts, replenishment] = await Promise.all([
    loadApprovedStandardCosts(),
    loadReplenishmentByProduct(),
  ]);
  const pendingByCode: Record<string, number> = {};
  for (const [code, r] of Object.entries(replenishment)) pendingByCode[code] = r.rop_30;

  return {
    plan: (plan as BuyingPlan | null) ?? null,
    lines,
    productCodes: activeCodes,
    productMaster,
    standardCosts,
    pendingByCode,
    planMonth,
  };
}

/** The material (fabric/RM) buying plan for a month — same workflow, second track. */
export async function loadMaterialPlan(planMonth = monthStart()) {
  const supabase = await client();
  const { data: plan } = await supabase
    .from('sd_buying_plan')
    .select('*')
    .eq('plan_month', planMonth)
    .eq('plan_type', 'material')
    .maybeSingle();

  const lines: BuyingPlanLine[] = [];
  if (plan) {
    const { data } = await supabase
      .from('sd_buying_plan_line')
      .select('*')
      .eq('plan_id', (plan as BuyingPlan).id)
      .order('product_code')
      .limit(PAGE_SIZE);
    lines.push(...((data ?? []) as BuyingPlanLine[]));
  }

  const [{ data: mats }, { data: colours }, materialCosts] = await Promise.all([
    supabase
      .from('sd_material_codes')
      .select('material_code, material_type, fabric_name, colour, base_fabric_code')
      .limit(PAGE_SIZE),
    supabase
      .from('sd_colour_master')
      .select('colour, is_active')
      .eq('is_active', true)
      .order('colour')
      .limit(PAGE_SIZE),
    loadApprovedMaterialCosts(),
  ]);

  return {
    plan: (plan as BuyingPlan | null) ?? null,
    lines,
    materialCodes: (mats ?? []) as MaterialCode[],
    colours: ((colours ?? []) as Colour[]).map((c) => c.colour),
    materialCosts,
    planMonth,
  };
}

/**
 * Actual issued quantity/value for the plan month, from the PO pipeline view
 * (sd_po_actuals_by_product_month = real EasyCom POs). Advisory — never blocks.
 */
export async function loadActualsByProduct(planMonth: string) {
  const supabase = await client();
  const { data } = await supabase
    .from('sd_po_actuals_by_product_month')
    .select('product_code, issued_qty, issued_value')
    .eq('plan_month', planMonth);

  // Key by normalized (trim + upper) product_code so the Buying Plan's per-line
  // lookup matches regardless of case/whitespace drift between the plan lines and
  // the issued-PO feed (item 4 — issued POs weren't "filling" the plan).
  const map = new Map<string, { qty: number; value: number }>();
  (
    (data ?? []) as {
      product_code: string | null;
      issued_qty: number | null;
      issued_value: number | null;
    }[]
  ).forEach((row) => {
    const code = (row.product_code ?? '').trim().toUpperCase();
    if (!code) return;
    const prev = map.get(code) ?? { qty: 0, value: 0 };
    map.set(code, {
      qty: prev.qty + (Number(row.issued_qty) || 0),
      value: prev.value + (Number(row.issued_value) || 0),
    });
  });
  return map;
}

export function buildBuyingPlanView(
  lines: BuyingPlanLine[],
  actuals: Map<string, { qty: number; value: number }>,
): BuyingPlanLineView[] {
  return lines.map((line) => {
    const totalQty =
      Number(line.job_work_qty || 0) +
      Number(line.fob_qty || 0) +
      Number(line.efob_qty || 0);
    const valueToBeBought = totalQty * Number(line.standard_value || 0);
    const actual = actuals.get(line.product_code) ?? { qty: 0, value: 0 };
    return {
      ...line,
      totalQty,
      valueToBeBought,
      actualIssuedQty: actual.qty,
      actualIssuedValue: actual.value,
      // Shown in red. Deliberately does NOT block submission.
      overPlan: actual.qty > totalQty && totalQty > 0,
    };
  });
}
