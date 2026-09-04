import 'server-only';
import { createClient, hasSupabaseEnv } from '@/lib/supabase/server';
import {
  buildVendorRollups,
  computeClosureCompliance,
  computeInternalStatus,
  daysBetween,
  isTnaHighRisk,
  istToday,
  parseIsoDate,
} from '@/lib/business-logic';
import { loadDashboardData, loadMergedTnaRecords } from '@/lib/data';
import { productClassOf } from '@/lib/doq-dashboard';
import { monthStart, addMonths, canApprove } from './approval';
import type {
  AnalyticsExtras,
  AnalyticsRuleRow,
  ApprovalNotification,
  ApprovalQueueItem,
  ApprovalLogRow,
  MyDashboardData,
  MySubmission,
  NpdBudget,
  BuyingPlan,
  BuyingPlanLine,
  BuyingPlanLineView,
  CashFlowMonth,
  Colour,
  CostStandards,
  DiscontinueRequest,
  DoqInventoryRow,
  FabricCostBase,
  FabricMaster,
  GrnDetail,
  MaterialCode,
  MaterialMaster,
  EeProductMaster,
  VendorMasterRow,
  InwardPlanGroup,
  InwardPlanEntry,
  NpdPromotionCandidate,
  DoqWindowMeta,
  DoqWindowRow,
  OosCalculationRow,
  OosSkuExclusion,
  PoApproval,
  PoApprovalLine,
  PoCycleTime,
  PoSubmissionGroup,
  TnaLeadtimes,
  PoDetails,
  ProductMaster,
  ReceivablePlanRow,
  ReplenishmentRow,
  VendorRecommendationRow,
  SdRole,
  SdStatus,
  SdCustomRole,
  SdUser,
  SyncStatusRow,
  VendorTerm,
  StandardCost,
  StandardCostLine,
  StandardCostRateHistory,
  CmtpComponent,
  CuttingRegister,
  DynamicLink,
  ProductBom,
  ProductCatalogItem,
  EfobFabricCost,
  PoClosure,
  PoClosureView,
  VendorCapacityLog,
  VendorTypeMultiplier,
} from './types';
import { routeApproval } from './approval';
import type { DiscontinuedInventoryRow } from '@/lib/discontinued';

/**
 * Reads for the write-side tables.
 *
 * PostgREST caps a response at 1000 rows, so anything that can grow past that
 * pages explicitly — same reason `fetchAllRows` exists in lib/data.ts.
 */
const PAGE_SIZE = 1000;

export class NotConfiguredError extends Error {
  constructor() {
    super(
      'Supabase is not configured. Workflow forms cannot run against local fixtures — set NEXT_PUBLIC_SUPABASE_URL and NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY.',
    );
    this.name = 'NotConfiguredError';
  }
}

async function client() {
  if (!hasSupabaseEnv()) throw new NotConfiguredError();
  return createClient();
}

/* ------------------------------------------------------------------ */
/* Identity                                                            */
/* ------------------------------------------------------------------ */

export async function currentUser(): Promise<SdUser | null> {
  const supabase = await client();
  const { data: claims } = await supabase.auth.getClaims();
  const email =
    typeof claims?.claims?.email === 'string'
      ? claims.claims.email.toLowerCase()
      : null;
  if (!email) return null;

  const { data } = await supabase
    .from('sd_user')
    .select('email, full_name, role, is_active')
    .eq('email', email)
    .maybeSingle();

  // Best-effort: stamp last-seen so the User Panel can show when each person last used
  // the dashboard. The RPC is throttled server-side (~5-min granularity) and scoped to
  // the caller's own row; never let it block or break auth.
  try {
    await supabase.rpc('sd_touch_last_seen');
  } catch {
    /* ignore — presence tracking must never fail a page load */
  }

  // Someone signed in with a valid @saadaa.in account but was never added to
  // sd_user. Treat as viewer rather than crashing — an admin adds them later.
  const user: SdUser = (data as SdUser | null) ?? {
    email,
    full_name: null,
    role: 'viewer',
    is_active: true,
  };

  // View access: union of pages across the user's custom roles (User Panel).
  // Admins and users with no custom roles are unrestricted (null).
  user.allowed_pages = null;
  if (user.role !== 'admin') {
    const { data: assignments } = await supabase
      .from('sd_user_role')
      .select('role_id, sd_custom_role(pages)')
      .eq('user_email', user.email);
    const rows = (assignments ?? []) as unknown as { role_id: number; sd_custom_role: { pages: string[] | null } | null }[];
    if (rows.length) {
      user.custom_role_ids = rows.map((r) => r.role_id);
      user.allowed_pages = [...new Set(rows.flatMap((r) => r.sd_custom_role?.pages ?? []))];
    }
  }
  return user;
}

/** All custom roles with their member emails, for the User Panel. */
export async function loadCustomRoles(): Promise<SdCustomRole[]> {
  const supabase = await client();
  const [{ data: roles }, { data: assignments }] = await Promise.all([
    supabase.from('sd_custom_role').select('id, name, description, pages').order('name'),
    supabase.from('sd_user_role').select('user_email, role_id'),
  ]);
  const members = new Map<number, string[]>();
  ((assignments ?? []) as { user_email: string; role_id: number }[]).forEach((a) => {
    members.set(a.role_id, [...(members.get(a.role_id) ?? []), a.user_email]);
  });
  return ((roles ?? []) as SdCustomRole[]).map((r) => ({
    ...r,
    pages: r.pages ?? [],
    members: members.get(r.id) ?? [],
  }));
}

/* ------------------------------------------------------------------ */
/* Main-dashboard analytics (cross-tab decision cards)                 */
/* ------------------------------------------------------------------ */

/**
 * Card thresholds from the editable Rules Master (sd_analytics_rule), with
 * hardcoded fallbacks matching the seeded defaults so the cards degrade
 * gracefully if the table is unreachable. Never throws.
 */
export const ANALYTICS_RULE_DEFAULTS: Record<string, number> = {
  capital_risk_quantile: 0.75,
  vendor_concentration_alert: 40,
  utilization_under_pct: 70,
  utilization_over_pct: 100,
  reliability_window_days: 180, // 2 quarters — a 60-day window rarely holds enough resolved PO cycles
  closure_sla_days: 15,
  // PO-type lead times (days) — Buying Plan time-buckets (spec §7).
  lead_days_job: 30,
  lead_days_efob: 45,
  lead_days_fob: 90,
  // IPDOQ (Replenishment): OOS-day fallback threshold + floor on the final rate.
  oos_day_threshold: 30,
  ipdoq_floor: 0.25,
  // Product Class (ABC/D) from IPDOQ: > a → A, ≥ b → B, ≥ c → C, else D.
  product_class_a_above: 10,
  product_class_b_min: 7,
  product_class_c_min: 3,
  // Data & sync card: a feed counts as stale after this many hours without refresh.
  sync_stale_hours: 30,
};

export async function loadAnalyticsRules(): Promise<Record<string, number>> {
  const rules = { ...ANALYTICS_RULE_DEFAULTS };
  try {
    const supabase = await client();
    const { data } = await supabase.from('sd_analytics_rule').select('rule_key, value');
    ((data ?? []) as { rule_key: string; value: number }[]).forEach((r) => {
      const v = Number(r.value);
      if (Number.isFinite(v)) rules[r.rule_key] = v;
    });
  } catch {
    /* fall back to defaults — cards must never take the dashboard down */
  }
  return rules;
}

/**
 * Full Rules Master rows (label + description + who/when) for the editor page.
 * Any code-default rule with no DB row yet is surfaced too, so it stays visible
 * and editable rather than silently missing.
 */
export async function loadAnalyticsRuleRows(): Promise<AnalyticsRuleRow[]> {
  const supabase = await client();
  const { data } = await supabase
    .from('sd_analytics_rule')
    .select('rule_key, value, label, description, updated_by, updated_at')
    .order('rule_key');
  const rows = ((data ?? []) as AnalyticsRuleRow[]).map((r) => ({
    ...r,
    value: Number(r.value),
  }));
  const seen = new Set(rows.map((r) => r.rule_key));
  for (const [key, val] of Object.entries(ANALYTICS_RULE_DEFAULTS)) {
    if (!seen.has(key)) {
      rows.push({ rule_key: key, value: val, label: key, description: null, updated_by: null, updated_at: null });
    }
  }
  return rows;
}

/**
 * Record today's TNA status mix for the compliance-trend card. Idempotent
 * (first dashboard load of the IST day wins, see sd_record_tna_snapshot) and
 * strictly best-effort.
 */
export async function recordTnaSnapshot(counts: {
  onTime: number;
  highRisk: number;
  overdue: number;
  openTotal: number;
}): Promise<void> {
  try {
    const supabase = await client();
    await supabase.rpc('sd_record_tna_snapshot', {
      p_on_time: counts.onTime,
      p_high_risk: counts.highRisk,
      p_overdue: counts.overdue,
      p_open_total: counts.openTotal,
    });
  } catch {
    /* best-effort only */
  }
}

/** The TNA snapshot history (oldest first), for the compliance-trend card. */
export async function loadTnaSnapshots(): Promise<
  { snapshot_date: string; on_time: number; high_risk: number; overdue: number; open_total: number }[]
> {
  try {
    const supabase = await client();
    const { data } = await supabase
      .from('sd_tna_status_snapshot')
      .select('snapshot_date, on_time, high_risk, overdue, open_total')
      .order('snapshot_date')
      .limit(120);
    return (data ?? []) as {
      snapshot_date: string; on_time: number; high_risk: number; overdue: number; open_total: number;
    }[];
  } catch {
    return [];
  }
}

/**
 * Server-computed sections for the analytics cards that need module data the
 * DashboardShell doesn't already carry (replenishment, buying plan, closures,
 * standard costs). Each section is independently best-effort: a failed source
 * yields null for that section (card shows "data not available"), never an
 * exception — the dashboard must always render.
 */
export async function loadAnalyticsExtras(
  openPos: { code: string; variant: string; qty: number }[],
  rules: Record<string, number>,
): Promise<AnalyticsExtras> {
  const supabase = await client();
  const norm = (s: string | null | undefined) => (s ?? '').trim().toUpperCase();
  const openVariants = new Set(openPos.map((p) => norm(p.variant)).filter(Boolean));

  const extras: AnalyticsExtras = {
    stockoutGaps: null,
    planRealization: null,
    tnaTrend: null,
    closure: null,
    costVariance: null,
    discontinued: null,
    issuedLastWeek: null,
    pendingApproval: null,
    inwardLastWeek: null,
    reliability: null,
    expectedVsActual: null,
    replenishment: null,
    oosSummary: null,
    vendorRec: null,
    inwardPipeline: null,
    productStateMix: null,
    syncHealth: null,
  };

  const weekAgoIso = new Date(Date.now() - 7 * 86_400_000).toISOString();
  const weekAgoDate = weekAgoIso.slice(0, 10);
  const todayDate = new Date().toISOString().slice(0, 10);

  /* POs issued in the last 7 days. */
  try {
    const { data } = await supabase
      .from('sd_po_approval')
      .select('po_ref_num, po_qty, vendor_name, po_issued_at')
      .gte('po_issued_at', weekAgoIso)
      .order('po_issued_at', { ascending: false });
    const rows = (data ?? []) as { po_ref_num: string | null; po_qty: number | null; vendor_name: string | null }[];
    extras.issuedLastWeek = {
      count: rows.length,
      qty: rows.reduce((s, r) => s + (Number(r.po_qty) || 0), 0),
      top: rows.slice(0, 5).map((r) => ({
        poRef: r.po_ref_num ?? '—',
        qty: Number(r.po_qty) || 0,
        vendor: r.vendor_name ?? '—',
      })),
    };
  } catch { /* stays null */ }

  /* POs pending approval right now (submitted / pending_l2). */
  try {
    const { data } = await supabase
      .from('sd_po_approval')
      .select('po_ref_num, po_qty, category, submitted_for_approval_at')
      .in('status', ['submitted', 'pending_l2'])
      .order('submitted_for_approval_at', { ascending: true });
    const rows = (data ?? []) as { po_ref_num: string | null; po_qty: number | null; category: string | null }[];
    extras.pendingApproval = {
      count: rows.length,
      qty: rows.reduce((s, r) => s + (Number(r.po_qty) || 0), 0),
      top: rows.slice(0, 5).map((r) => ({
        poRef: r.po_ref_num ?? '—',
        qty: Number(r.po_qty) || 0,
        category: (r.category ?? '').toUpperCase(),
      })),
    };
  } catch { /* stays null */ }

  /* Inward last week: planned (arrivals due last week, still-open lines) vs actual
     (GRN received last week). Approximate — the two aren't line-matched. */
  try {
    const [{ data: due }, { data: grn }] = await Promise.all([
      supabase
        .from('sd_po_lines_enriched')
        .select('original_qty, expected_delivery_date')
        .eq('po_status_code', 3)
        .gte('expected_delivery_date', weekAgoDate)
        .lte('expected_delivery_date', todayDate),
      supabase
        .from('sd_ee_grn')
        .select('received_quantity, grn_created_at')
        .gte('grn_created_at', weekAgoDate),
    ]);
    const planned = ((due ?? []) as { original_qty: number | null }[]).reduce((s, r) => s + (Number(r.original_qty) || 0), 0);
    const actual = ((grn ?? []) as { received_quantity: number | null }[]).reduce((s, r) => s + (Number(r.received_quantity) || 0), 0);
    extras.inwardLastWeek = { planned, actual };
  } catch { /* stays null */ }

  // Weave + lifecycle per product code — shared by 1.5 and 1.10.
  let weaveByCode: Record<string, string> = {};
  let discontinuedCodes = new Set<string>();
  try {
    const { data } = await supabase
      .from('sd_ee_product_code_status')
      .select('product_code, product_status, fabric_type');
    const stateCounts = new Map<string, number>();
    ((data ?? []) as { product_code: string; product_status: string | null; fabric_type: string | null }[]).forEach((r) => {
      if (r.fabric_type) weaveByCode[r.product_code] = r.fabric_type;
      if (r.product_status === 'Discontinued') discontinuedCodes.add(r.product_code);
      const state = (r.product_status ?? '').trim() || 'Unmapped';
      stateCounts.set(state, (stateCounts.get(state) ?? 0) + 1);
    });
    if (stateCounts.size) {
      extras.productStateMix = [...stateCounts.entries()]
        .map(([state, count]) => ({ state, count }))
        .sort((a, b) => b.count - a.count);
    }
  } catch {
    weaveByCode = {};
    discontinuedCodes = new Set();
  }

  /* 1.4 Stockout Risk — EVERY variant with no stock and no open PO covering it.
     No demand/DOQ threshold (a stockout is a stockout); the full list is instead
     segmented by ABC/D class so priority is shown, not used to hide items. */
  try {
    const classRules = {
      aAbove: rules.product_class_a_above ?? 10,
      bMin: rules.product_class_b_min ?? 7,
      cMin: rules.product_class_c_min ?? 3,
    };
    const { data } = await supabase
      .from('sd_replenishment')
      .select('product_variant, product_code, product_name, current_stock, doq_45, ipdoq, oos_flag')
      .limit(2000);
    extras.stockoutGaps = ((data ?? []) as {
      product_variant: string; product_code: string | null; product_name: string | null;
      current_stock: number | null; doq_45: number | null; ipdoq: number | null; oos_flag: boolean | null;
    }[])
      .filter(
        (r) =>
          (Number(r.current_stock) || 0) <= 0 &&
          !openVariants.has(norm(r.product_variant)),
      )
      .map((r) => ({
        product_variant: r.product_variant,
        product_code: r.product_code,
        product_name: r.product_name,
        doq_45: Number(r.doq_45) || 0,
        current_stock: Number(r.current_stock) || 0,
        oos: Boolean(r.oos_flag),
        // ABC/D from the DOQ-based velocity (ipdoq), same classifier used elsewhere.
        abc_class: productClassOf(Number(r.ipdoq ?? r.doq_45) || 0, classRules),
      }))
      // Highest-velocity first so A/B surface at the top of the list + CSV.
      .sort((a, b) => b.doq_45 - a.doq_45);
  } catch { /* section stays null */ }

  /* 1.9 Delivery reliability — per-vendor delay rate over the Rules-Master window
     (default 2 quarters), combining COMPLETED POs (final delivered status) and
     OPEN POs (in-flight), deduped by PO number. See sd_vendor_reliability(). */
  try {
    const windowDays = Math.round(rules.reliability_window_days ?? 180);
    const { data } = await supabase.rpc('sd_vendor_reliability', { p_window_days: windowDays });
    extras.reliability = {
      windowDays,
      vendors: ((data ?? []) as {
        vendor_code: string | null; vendor_name: string | null;
        total_pos: number | null; delayed_pos: number | null;
        completed_pos: number | null; open_pos: number | null; delay_pct: number | null;
      }[]).map((r) => ({
        vendorCode: r.vendor_code,
        vendorName: r.vendor_name ?? '—',
        total: Number(r.total_pos) || 0,
        delayed: Number(r.delayed_pos) || 0,
        completed: Number(r.completed_pos) || 0,
        open: Number(r.open_pos) || 0,
        pct: Number(r.delay_pct) || 0,
      })),
    };
  } catch { /* section stays null */ }

  /* Item 3 — Expected vs actual delivery volume, last 12 ISO weeks. From completed
     POs: expected = qty due that week (by EDD), actual = qty that completed that
     week (by po_updated_date). The gap between them is the delivery slippage. */
  try {
    const from12w = new Date(Date.now() - 12 * 7 * 86_400_000).toISOString().slice(0, 10);
    const { data } = await supabase
      .from('sd_po_completed')
      .select('original_qty, expected_delivery_date, po_updated_date')
      .or(`expected_delivery_date.gte.${from12w},po_updated_date.gte.${from12w}`)
      .limit(PAGE_SIZE);
    // Monday-anchored week key for a date string (YYYY-MM-DD).
    const weekKey = (d: string) => {
      const dt = new Date(`${d.slice(0, 10)}T00:00:00Z`);
      const dow = dt.getUTCDay(); // 0 = Sun
      const back = dow === 0 ? 6 : dow - 1;
      return new Date(dt.getTime() - back * 86_400_000).toISOString().slice(0, 10);
    };
    const weeks = new Map<string, { expected: number; actual: number }>();
    // Seed the last 12 weeks so gaps render as zero, not missing points.
    const monday = (() => {
      const t = new Date();
      const dow = t.getUTCDay();
      const back = dow === 0 ? 6 : dow - 1;
      return new Date(Date.UTC(t.getUTCFullYear(), t.getUTCMonth(), t.getUTCDate() - back));
    })();
    for (let i = 11; i >= 0; i--) {
      const wk = new Date(monday.getTime() - i * 7 * 86_400_000).toISOString().slice(0, 10);
      weeks.set(wk, { expected: 0, actual: 0 });
    }
    for (const r of (data ?? []) as {
      original_qty: number | null; expected_delivery_date: string | null; po_updated_date: string | null;
    }[]) {
      const qty = Number(r.original_qty) || 0;
      if (r.expected_delivery_date) {
        const wk = weekKey(r.expected_delivery_date);
        if (weeks.has(wk)) weeks.get(wk)!.expected += qty;
      }
      if (r.po_updated_date) {
        const wk = weekKey(r.po_updated_date);
        if (weeks.has(wk)) weeks.get(wk)!.actual += qty;
      }
    }
    extras.expectedVsActual = [...weeks.entries()].map(([week, v]) => ({
      week,
      expected: v.expected,
      actual: v.actual,
    }));
  } catch { /* section stays null */ }

  /* Months for 1.5 / 1.8 / 1.10 — current + two prior (IST). */
  const ist = new Date(Date.now() + 5.5 * 3600_000);
  const months: string[] = [0, 1, 2].map((back) => {
    const d = new Date(Date.UTC(ist.getUTCFullYear(), ist.getUTCMonth() - back, 1));
    return d.toISOString().slice(0, 10); // YYYY-MM-01
  });

  /* 1.5 Buying Plan Realization — planned vs issued value per month × weave. */
  try {
    const stdCosts = await loadApprovedStandardCosts();
    const { data: plans } = await supabase
      .from('sd_buying_plan')
      .select('id, plan_month, status')
      .eq('plan_type', 'fg')
      .in('plan_month', months);
    // One plan per month: prefer the approved one, else the latest.
    const planByMonth = new Map<string, { id: number; rank: number }>();
    ((plans ?? []) as { id: number; plan_month: string; status: string }[]).forEach((p) => {
      const rank = p.status === 'approved' ? 2 : 1;
      const cur = planByMonth.get(p.plan_month);
      if (!cur || rank > cur.rank || (rank === cur.rank && p.id > cur.id)) {
        planByMonth.set(p.plan_month, { id: p.id, rank });
      }
    });
    const planIds = [...planByMonth.values()].map((p) => p.id);
    const { data: lines } = planIds.length
      ? await supabase
          .from('sd_buying_plan_line')
          .select('plan_id, product_code, job_work_qty, fob_qty, efob_qty, standard_value')
          .in('plan_id', planIds)
      : { data: [] };
    const monthOfPlan = new Map<number, string>();
    planByMonth.forEach((v, month) => monthOfPlan.set(v.id, month));

    const { data: actuals } = await supabase
      .from('sd_po_actuals_by_product_month')
      .select('product_code, plan_month, issued_value')
      .in('plan_month', months);

    const bucketOf = (code: string) => weaveByCode[code] ?? 'Other';
    const acc = new Map<string, { planned: number; actual: number }>(); // `${month}|${bucket}`
    const bump = (month: string, bucket: string, field: 'planned' | 'actual', v: number) => {
      const k = `${month}|${bucket}`;
      const cur = acc.get(k) ?? { planned: 0, actual: 0 };
      cur[field] += v;
      acc.set(k, cur);
    };
    ((lines ?? []) as {
      plan_id: number; product_code: string; job_work_qty: number | null;
      fob_qty: number | null; efob_qty: number | null; standard_value: number | null;
    }[]).forEach((l) => {
      const month = monthOfPlan.get(l.plan_id);
      if (!month) return;
      const cost = stdCosts[l.product_code];
      const stored = Number(l.standard_value) || 0;
      const value =
        stored > 0
          ? stored
          : cost
            ? (Number(l.job_work_qty) || 0) * cost.job +
              (Number(l.fob_qty) || 0) * cost.fob +
              (Number(l.efob_qty) || 0) * cost.efob
            : 0;
      if (value > 0) bump(month, bucketOf(l.product_code), 'planned', value);
    });
    ((actuals ?? []) as { product_code: string; plan_month: string; issued_value: number | null }[]).forEach((a) => {
      const v = Number(a.issued_value) || 0;
      if (v > 0) bump(a.plan_month, bucketOf(a.product_code), 'actual', v);
    });

    extras.planRealization = months.map((month) => ({
      month: month.slice(0, 7),
      buckets: ['Woven', 'Knitted', 'Other']
        .map((category) => ({
          category,
          planned: acc.get(`${month}|${category}`)?.planned ?? 0,
          actual: acc.get(`${month}|${category}`)?.actual ?? 0,
        }))
        .filter((b) => b.planned > 0 || b.actual > 0),
    }));
  } catch { /* section stays null */ }

  /* 1.6 TNA compliance trend — recorded daily by the dashboard itself. */
  extras.tnaTrend = await loadTnaSnapshots();

  /* 1.7 PO Closure compliance vs the SLA. */
  try {
    const sla = rules.closure_sla_days ?? 15;
    const { data } = await supabase
      .from('sd_po_closure')
      .select('easycom_completed_at, closed_at');
    const rows = (data ?? []) as { easycom_completed_at: string | null; closed_at: string | null }[];
    const dayMs = 86_400_000;
    const now = Date.now();
    let closedTotal = 0, closedWithinSla = 0, openBeyondSla = 0;
    rows.forEach((r) => {
      const completed = r.easycom_completed_at ? Date.parse(r.easycom_completed_at) : NaN;
      if (Number.isNaN(completed)) return;
      if (r.closed_at) {
        closedTotal += 1;
        if (Date.parse(r.closed_at) - completed <= sla * dayMs) closedWithinSla += 1;
      } else if (now - completed > sla * dayMs) {
        openBeyondSla += 1;
      }
    });
    extras.closure = { closedTotal, closedWithinSla, openBeyondSla, slaDays: sla };
  } catch { /* section stays null */ }

  /* 1.8 Cost variance — approved POs issued above standard this month. */
  try {
    const stdCosts = await loadApprovedStandardCosts();
    const monthStartIso = months[0];
    const { data } = await supabase
      .from('sd_po_approval')
      .select('po_ref_num, product_code, po_type, rate, po_qty, approved_at, po_issued_at')
      .eq('status', 'approved');
    const rows = (data ?? []) as {
      po_ref_num: string | null; product_code: string | null; po_type: string | null;
      rate: number | null; po_qty: number | null; approved_at: string | null; po_issued_at: string | null;
    }[];
    const variances = rows
      .filter((r) => {
        const when = r.po_issued_at ?? r.approved_at;
        return when != null && when >= monthStartIso;
      })
      .map((r) => {
        const std = stdCosts[r.product_code ?? ''];
        if (!std || r.rate == null) return null;
        const type = (r.po_type ?? '').toLowerCase();
        const stdRate = type.includes('job') ? std.job : type.includes('efob') ? std.efob : std.fob;
        if (!stdRate) return null;
        const delta = (Number(r.rate) - stdRate) * (Number(r.po_qty) || 0);
        return delta > 0
          ? { poRef: r.po_ref_num ?? '—', productCode: r.product_code ?? '—', delta }
          : null;
      })
      .filter(Boolean) as { poRef: string; productCode: string; delta: number }[];
    variances.sort((a, b) => b.delta - a.delta);
    extras.costVariance = {
      count: variances.length,
      impact: variances.reduce((s, v) => s + v.delta, 0),
      top: variances.slice(0, 3),
    };
  } catch { /* section stays null */ }

  /* 1.10 Discontinued-but-active integrity check. */
  try {
    if (discontinuedCodes.size >= 0) {
      const offendersPo = openPos.filter((p) => discontinuedCodes.has(p.code));
      let planLineCount = 0;
      const { data: curPlan } = await supabase
        .from('sd_buying_plan')
        .select('id')
        .eq('plan_type', 'fg')
        .eq('plan_month', months[0])
        .order('id', { ascending: false })
        .limit(1)
        .maybeSingle();
      if (curPlan) {
        const { data: lines } = await supabase
          .from('sd_buying_plan_line')
          .select('product_code, job_work_qty, fob_qty, efob_qty')
          .eq('plan_id', (curPlan as { id: number }).id);
        planLineCount = ((lines ?? []) as {
          product_code: string; job_work_qty: number | null; fob_qty: number | null; efob_qty: number | null;
        }[]).filter(
          (l) =>
            discontinuedCodes.has(l.product_code) &&
            (Number(l.job_work_qty) || 0) + (Number(l.fob_qty) || 0) + (Number(l.efob_qty) || 0) > 0,
        ).length;
      }
      extras.discontinued = {
        openPoCount: offendersPo.length,
        openPoQty: offendersPo.reduce((s, p) => s + p.qty, 0),
        planLineCount,
        codes: [...new Set(offendersPo.map((p) => p.code))],
      };
    }
  } catch { /* section stays null */ }

  /* 04 Workspace — replenishment queue: variants the ROP maths says to order now. */
  try {
    const rows: { rop_30: number | null; oos_flag: boolean | null }[] = [];
    for (let from = 0; ; from += PAGE_SIZE) {
      const { data, error } = await supabase
        .from('sd_replenishment')
        .select('rop_30, oos_flag')
        .gt('rop_30', 0)
        .range(from, from + PAGE_SIZE - 1);
      if (error) throw error;
      if (!data?.length) break;
      rows.push(...(data as { rop_30: number | null; oos_flag: boolean | null }[]));
      if (data.length < PAGE_SIZE) break;
    }
    extras.replenishment = {
      variants: rows.length,
      rop30Qty: rows.reduce((s, r) => s + (Number(r.rop_30) || 0), 0),
      oosVariants: rows.filter((r) => Boolean(r.oos_flag)).length,
    };
  } catch { /* section stays null */ }

  /* 04 Workspace — OOS Calculation summary (head counts only; detail is on the page). */
  try {
    const [total, zero, day] = await Promise.all([
      supabase.from('sd_oos_calculation').select('sku', { count: 'exact', head: true }),
      supabase
        .from('sd_oos_calculation')
        .select('sku', { count: 'exact', head: true })
        .lte('current_stock', 0),
      supabase
        .from('sd_inventory_planning')
        .select('date_day')
        .order('date_day', { ascending: false })
        .limit(1),
    ]);
    extras.oosSummary = {
      totalSkus: total.count ?? 0,
      zeroStock: zero.count ?? 0,
      dataAsOf: (day.data?.[0] as { date_day?: string } | undefined)?.date_day ?? null,
    };
  } catch { /* section stays null */ }

  /* 04 Workspace — vendor recommendation extremes (≥3 completed POs to count). */
  try {
    const { data } = await supabase
      .from('sd_vendor_recommendation')
      .select('vendor_name, pos_completed, on_time_rate_pct, delay_rate_pct')
      .limit(PAGE_SIZE);
    const rated = ((data ?? []) as {
      vendor_name: string | null; pos_completed: number | null;
      on_time_rate_pct: number | null; delay_rate_pct: number | null;
    }[]).filter((r) => (Number(r.pos_completed) || 0) >= 3);
    extras.vendorRec = {
      rated: rated.length,
      best: rated
        .filter((r) => r.on_time_rate_pct != null)
        .sort((a, b) => Number(b.on_time_rate_pct) - Number(a.on_time_rate_pct))
        .slice(0, 3)
        .map((r) => ({
          name: r.vendor_name ?? '—',
          onTimePct: Math.round(Number(r.on_time_rate_pct) || 0),
          completed: Number(r.pos_completed) || 0,
        })),
      risky: rated
        .filter((r) => (Number(r.delay_rate_pct) || 0) >= 50)
        .sort((a, b) => Number(b.delay_rate_pct) - Number(a.delay_rate_pct))
        .slice(0, 3)
        .map((r) => ({
          name: r.vendor_name ?? '—',
          delayPct: Math.round(Number(r.delay_rate_pct) || 0),
          completed: Number(r.pos_completed) || 0,
        })),
    };
  } catch { /* section stays null */ }

  /* 04 Workspace — inward pipeline: open Approved lines still to arrive, by EDD. */
  try {
    const lines: { pending_qty: number | null; expected_delivery_date: string | null }[] = [];
    for (let from = 0; ; from += PAGE_SIZE) {
      const { data, error } = await supabase
        .from('sd_po_lines_enriched')
        .select('pending_qty, expected_delivery_date')
        .eq('po_status_code', 3)
        .gt('pending_qty', 0)
        .range(from, from + PAGE_SIZE - 1);
      if (error) throw error;
      if (!data?.length) break;
      lines.push(...(data as { pending_qty: number | null; expected_delivery_date: string | null }[]));
      if (data.length < PAGE_SIZE) break;
    }
    const in7 = new Date(Date.now() + 7 * 86_400_000).toISOString().slice(0, 10);
    const pipe = { next7Qty: 0, next7Lines: 0, overdueQty: 0, overdueLines: 0, noEddLines: 0, totalQty: 0 };
    lines.forEach((l) => {
      const qty = Number(l.pending_qty) || 0;
      pipe.totalQty += qty;
      const edd = l.expected_delivery_date;
      if (!edd) pipe.noEddLines += 1;
      else if (edd < todayDate) { pipe.overdueQty += qty; pipe.overdueLines += 1; }
      else if (edd <= in7) { pipe.next7Qty += qty; pipe.next7Lines += 1; }
    });
    extras.inwardPipeline = pipe;
  } catch { /* section stays null */ }

  /* 05 Data & sync — feed freshness from the Sync Health view. */
  try {
    const staleHours = rules.sync_stale_hours ?? 30;
    const { data } = await supabase
      .from('sd_sync_status')
      .select('source, pipeline, last_refreshed');
    const rows = (data ?? []) as { source: string; pipeline: string; last_refreshed: string | null }[];
    const now = Date.now();
    const aged = rows.map((r) => ({
      source: r.source,
      pipeline: r.pipeline,
      hoursAgo: r.last_refreshed
        ? Math.round((now - Date.parse(r.last_refreshed)) / 3600_000)
        : Number.POSITIVE_INFINITY,
    }));
    const finiteAges = aged.map((r) => r.hoursAgo).filter(Number.isFinite);
    extras.syncHealth = {
      feeds: rows.length,
      staleHours,
      stale: aged
        .filter((r) => r.hoursAgo > staleHours)
        .sort((a, b) => b.hoursAgo - a.hoursAgo)
        .slice(0, 4)
        .map((r) => ({ ...r, hoursAgo: Number.isFinite(r.hoursAgo) ? r.hoursAgo : 999 })),
      oldestHours: finiteAges.length ? Math.max(...finiteAges) : null,
    };
  } catch { /* section stays null */ }

  return extras;
}

/** Cash-flow forecast (payment obligations by month) + editable vendor terms. */
export async function loadCashFlow(): Promise<{
  months: CashFlowMonth[];
  vendorTerms: VendorTerm[];
}> {
  const supabase = await client();
  const [{ data: rows }, { data: terms }] = await Promise.all([
    supabase.from('sd_cash_flow_by_month').select('source, due_month, amount, items'),
    supabase
      .from('sd_vendor_payment_terms')
      .select('vendor_code, vendor_name, payment_terms_days')
      .order('vendor_code'),
  ]);

  const byMonth = new Map<string, CashFlowMonth>();
  (
    (rows ?? []) as { source: string; due_month: string; amount: number; items: number }[]
  ).forEach((r) => {
    const cur =
      byMonth.get(r.due_month) ??
      { due_month: r.due_month, received: 0, projected: 0, total: 0, items: 0 };
    const amt = Number(r.amount) || 0;
    if (r.source === 'received') cur.received += amt;
    else cur.projected += amt;
    cur.total += amt;
    cur.items += Number(r.items) || 0;
    byMonth.set(r.due_month, cur);
  });

  return {
    months: [...byMonth.values()].sort((a, b) => a.due_month.localeCompare(b.due_month)),
    vendorTerms: (terms ?? []) as VendorTerm[],
  };
}

/** Replenishment recommendations (colours needing reorder), for the module page. */
export async function loadReplenishment(): Promise<ReplenishmentRow[]> {
  const supabase = await client();
  const rows: ReplenishmentRow[] = [];
  for (let from = 0; ; from += PAGE_SIZE) {
    const { data, error } = await supabase
      .from('sd_replenishment')
      .select('*')
      .gt('rop_30', 0)
      .order('rop_30', { ascending: false })
      .range(from, from + PAGE_SIZE - 1);
    if (error) throw new Error(`sd_replenishment: ${error.message}`);
    if (!data?.length) break;
    rows.push(...(data as ReplenishmentRow[]));
    if (data.length < PAGE_SIZE) break;
  }
  return rows;
}

/** Product-code → ROP quantities, feeding the Buying Plan's computed Pending Qty. */
export async function loadReplenishmentByProduct(): Promise<
  Record<string, { rop_30: number; rop_60: number; rop_90: number }>
> {
  const supabase = await client();
  const { data } = await supabase
    .from('sd_replenishment_by_product')
    .select('product_code, rop_30, rop_60, rop_90')
    .limit(PAGE_SIZE);
  const map: Record<string, { rop_30: number; rop_60: number; rop_90: number }> = {};
  (
    (data ?? []) as { product_code: string; rop_30: number; rop_60: number; rop_90: number }[]
  ).forEach((r) => {
    map[r.product_code] = {
      rop_30: Number(r.rop_30) || 0,
      rop_60: Number(r.rop_60) || 0,
      rop_90: Number(r.rop_90) || 0,
    };
  });
  return map;
}

/** Per-vendor completed-PO performance (completion / on-time / delay) for the
 *  Vendor Recommendation screen. From sd_vendor_recommendation (live source). */
export async function loadVendorRecommendation(): Promise<VendorRecommendationRow[]> {
  const supabase = await client();
  const { data, error } = await supabase
    .from('sd_vendor_recommendation')
    .select('*')
    .limit(PAGE_SIZE);
  if (error) throw new Error(`sd_vendor_recommendation: ${error.message}`);
  return (data ?? []) as VendorRecommendationRow[];
}

/** The OOS Calculation sheet — one row per SKU, read-only. Paged (can exceed 1000). */
export async function loadOosCalculation(): Promise<OosCalculationRow[]> {
  const supabase = await client();
  const rows: OosCalculationRow[] = [];
  for (let from = 0; ; from += PAGE_SIZE) {
    const { data, error } = await supabase
      .from('sd_oos_calculation')
      .select('*')
      .order('sku')
      .range(from, from + PAGE_SIZE - 1);
    if (error) throw new Error(`sd_oos_calculation: ${error.message}`);
    rows.push(...((data ?? []) as OosCalculationRow[]));
    if (!data || data.length < PAGE_SIZE) break;
  }
  return rows;
}

/** Team-managed SKU exclusion list for the OOS Calculation view. */
export async function loadOosExclusions(): Promise<OosSkuExclusion[]> {
  const supabase = await client();
  const { data, error } = await supabase
    .from('sd_oos_sku_exclusion')
    .select('*')
    .order('added_at', { ascending: false })
    .limit(PAGE_SIZE);
  if (error) throw new Error(`sd_oos_sku_exclusion: ${error.message}`);
  return (data ?? []) as OosSkuExclusion[];
}

/** The snapshot date whose data the OOS/DOQ tabs are showing, + last refresh. */
export async function loadOosMeta(): Promise<{ dataAsOf: string | null; lastSynced: string | null }> {
  const supabase = await client();
  const [{ data: day }, { data: sync }] = await Promise.all([
    supabase
      .from('sd_inventory_planning')
      .select('date_day')
      .order('date_day', { ascending: false })
      .limit(1),
    supabase
      .from('sd_oos_calculation')
      .select('synced_at')
      .order('synced_at', { ascending: false })
      .limit(1),
  ]);
  return {
    dataAsOf: (day?.[0] as { date_day?: string } | undefined)?.date_day ?? null,
    lastSynced: (sync?.[0] as { synced_at?: string } | undefined)?.synced_at ?? null,
  };
}

/** Per-SKU DOQ-dashboard window aggregates, keyed by SKU. Paged (12k+ rows). */
export async function loadDoqWindows(): Promise<Record<string, DoqWindowRow>> {
  const supabase = await client();
  const map: Record<string, DoqWindowRow> = {};
  for (let from = 0; ; from += PAGE_SIZE) {
    const { data, error } = await supabase
      .from('sd_doq_window')
      .select('*')
      .range(from, from + PAGE_SIZE - 1);
    if (error) throw new Error(`sd_doq_window: ${error.message}`);
    for (const r of (data ?? []) as DoqWindowRow[]) map[r.sku] = r;
    if (!data || data.length < PAGE_SIZE) break;
  }
  return map;
}

/** Per-SKU IPDOQ inputs (doq_45 / doq_365 / oos_days_45, max across warehouses)
 *  for Product Class computation. From the latest inventory snapshot. */
export async function loadSkuClassInputs(): Promise<
  Record<string, { doq45: number; doq365: number; oos45: number }>
> {
  const supabase = await client();
  const map: Record<string, { doq45: number; doq365: number; oos45: number }> = {};
  for (let from = 0; ; from += PAGE_SIZE) {
    const { data, error } = await supabase
      .from('sd_inventory_planning')
      .select('sku, doq_45, doq_365, oos_days_45')
      .range(from, from + PAGE_SIZE - 1);
    if (error) throw new Error(`sd_inventory_planning: ${error.message}`);
    for (const r of (data ?? []) as { sku: string | null; doq_45: number | null; doq_365: number | null; oos_days_45: number | null }[]) {
      if (!r.sku) continue;
      const cur = (map[r.sku] ??= { doq45: 0, doq365: 0, oos45: 0 });
      cur.doq45 = Math.max(cur.doq45, r.doq_45 ?? 0);
      cur.doq365 = Math.max(cur.doq365, r.doq_365 ?? 0);
      cur.oos45 = Math.max(cur.oos45, r.oos_days_45 ?? 0);
    }
    if (!data || data.length < PAGE_SIZE) break;
  }
  return map;
}

/** Window descriptors (labels, ranges, day counts) for the DOQ dashboard. */
export async function loadDoqWindowMeta(): Promise<DoqWindowMeta | null> {
  const supabase = await client();
  const { data } = await supabase
    .from('sd_doq_window_meta')
    .select('windows')
    .eq('id', 1)
    .maybeSingle();
  return ((data as { windows?: DoqWindowMeta } | null)?.windows) ?? null;
}

/** sku → launch date + MRP from the EasyEcom product master, for OOS fallbacks. */
export async function loadPmLaunchPrice(): Promise<
  Record<string, { launch: string | null; mrp: number | null }>
> {
  const supabase = await client();
  const map: Record<string, { launch: string | null; mrp: number | null }> = {};
  for (let from = 0; ; from += PAGE_SIZE) {
    const { data, error } = await supabase
      .from('sd_ee_product_master')
      .select('sku, product_launch_date, mrp')
      .range(from, from + PAGE_SIZE - 1);
    if (error) throw new Error(`sd_ee_product_master: ${error.message}`);
    for (const r of (data ?? []) as { sku: string; product_launch_date: string | null; mrp: string | null }[]) {
      if (!r.sku) continue;
      const mrp = Number(r.mrp);
      map[r.sku] = {
        launch: r.product_launch_date || null,
        mrp: Number.isFinite(mrp) && mrp > 0 ? mrp : null,
      };
    }
    if (!data || data.length < PAGE_SIZE) break;
  }
  return map;
}

/** The EasyEcom product master — one row per SKU, read-only. Paged (exceeds 1000). */
export async function loadEeProductMaster(): Promise<EeProductMaster[]> {
  const supabase = await client();
  const rows: EeProductMaster[] = [];
  for (let from = 0; ; from += PAGE_SIZE) {
    const { data, error } = await supabase
      .from('sd_ee_product_master')
      .select('*')
      .order('sku')
      .range(from, from + PAGE_SIZE - 1);
    if (error) throw new Error(`sd_ee_product_master: ${error.message}`);
    rows.push(...((data ?? []) as EeProductMaster[]));
    if (!data || data.length < PAGE_SIZE) break;
  }
  return rows;
}

// The GRN detail table has 170k+ rows — far too many to ship to the browser at
// once. The viewer page shows the most recent slice; bump if a wider window is
// needed (it stays a client-side table, so keep it in the low thousands).
const GRN_DETAIL_LIMIT = 5000;

/** Inbound-QC GRN detail (sd_ee_grn) — most recent lines, capped (see GRN_DETAIL_LIMIT). */
export async function loadGrnDetail(): Promise<GrnDetail[]> {
  const supabase = await client();
  const { data, error } = await supabase
    .from('sd_ee_grn')
    .select('*')
    .order('grn_created_at', { ascending: false, nullsFirst: false })
    .limit(GRN_DETAIL_LIMIT);
  if (error) throw new Error(`sd_ee_grn: ${error.message}`);
  return (data ?? []) as GrnDetail[];
}

export const grnDetailLimit = GRN_DETAIL_LIMIT;

/** Daily DOQ snapshot (sd_inventory_planning) — one row per SKU×warehouse. Paged (exceeds 1000). */
export async function loadDoqDataset(): Promise<DoqInventoryRow[]> {
  const supabase = await client();
  const rows: DoqInventoryRow[] = [];
  for (let from = 0; ; from += PAGE_SIZE) {
    const { data, error } = await supabase
      .from('sd_inventory_planning')
      .select('*')
      .order('sku')
      .range(from, from + PAGE_SIZE - 1);
    if (error) throw new Error(`sd_inventory_planning: ${error.message}`);
    rows.push(...((data ?? []) as DoqInventoryRow[]));
    if (!data || data.length < PAGE_SIZE) break;
  }
  return rows;
}

/** Vendor master (vendor_master_data) — identity + capacity model + contacts, read-only. */
export async function loadVendorMaster(): Promise<VendorMasterRow[]> {
  const supabase = await client();
  const { data, error } = await supabase
    .from('vendor_master_data')
    .select('*')
    .order('vendor_name');
  if (error) throw new Error(`vendor_master_data: ${error.message}`);
  return (data ?? []) as VendorMasterRow[];
}

/** Every product's master row + the NPD-promotion candidates, for the panel. */
export async function loadProductMaster(): Promise<{
  products: ProductMaster[];
  npdCandidates: NpdPromotionCandidate[];
}> {
  const supabase = await client();
  const [{ data: products }, { data: candidates }] = await Promise.all([
    supabase.from('sd_product_master').select('*').order('product_code').limit(PAGE_SIZE),
    supabase.from('sd_npd_promotion_candidates').select('*').limit(PAGE_SIZE),
  ]);
  return {
    products: (products ?? []) as ProductMaster[],
    npdCandidates: (candidates ?? []) as NpdPromotionCandidate[],
  };
}

/** PO Details Form submissions (Google Form), newest first, for the read-only page. */
export async function loadPoDetails(): Promise<PoDetails[]> {
  const supabase = await client();
  const { data } = await supabase
    .from('sd_po_details')
    .select('*')
    .order('submitted_at', { ascending: false, nullsFirst: false })
    .limit(PAGE_SIZE);
  return (data ?? []) as PoDetails[];
}

/** Every fabric master row, for the Fabric Master admin page. */
export async function loadFabricMaster(): Promise<FabricMaster[]> {
  const supabase = await client();
  const { data } = await supabase
    .from('sd_fabric_master')
    .select('*')
    .order('fabric_code')
    .limit(PAGE_SIZE);
  return (data ?? []) as FabricMaster[];
}

/** Fabric cost base sheet (grey / processing / finished + yarn→grey), for /fabric-cost. */
export async function loadFabricCostBase(): Promise<FabricCostBase[]> {
  const supabase = await client();
  const { data } = await supabase
    .from('sd_fabric_cost_base')
    .select('*')
    .order('fabric_code')
    .limit(PAGE_SIZE);
  return (data ?? []) as FabricCostBase[];
}

/** Every standard-cost row, for the Standard Cost sheet page. */
export async function loadStandardCosts(): Promise<StandardCost[]> {
  const supabase = await client();
  const { data } = await supabase
    .from('sd_standard_cost')
    .select('*')
    .order('product_code')
    .limit(PAGE_SIZE);
  return (data ?? []) as StandardCost[];
}

/** The document-once standard cost fields (singleton). */
export async function loadCostStandards(): Promise<CostStandards> {
  const supabase = await client();
  const { data } = await supabase.from('sd_cost_standards').select('*').eq('id', 1).maybeSingle();
  return (
    (data as CostStandards | null) ?? {
      id: 1,
      fabric_cost: null,
      dyeing_cost: null,
      shrinkage_pct: null,
      margin_pct: null,
      payment_terms: null,
      updated_by: null,
      updated_at: '',
    }
  );
}

/** Colour/size cost detail lines (all products), for the Standard Cost expand panels. */
export async function loadStandardCostLines(): Promise<StandardCostLine[]> {
  const supabase = await client();
  const { data } = await supabase
    .from('sd_standard_cost_line')
    .select('*')
    .order('product_code')
    .order('colour')
    .order('size')
    .limit(PAGE_SIZE);
  return (data ?? []) as StandardCostLine[];
}

/** product_code → standard CM (CMTP total), to pre-fill the PO cost pivot. */
export async function loadStandardCmByCode(): Promise<Record<string, number>> {
  const supabase = await client();
  const { data } = await supabase
    .from('sd_standard_cost')
    .select('product_code, cm_cost')
    .not('cm_cost', 'is', null)
    .limit(PAGE_SIZE);
  const map: Record<string, number> = {};
  for (const r of (data ?? []) as { product_code: string; cm_cost: number | null }[]) {
    if (r.cm_cost != null) map[r.product_code] = Number(r.cm_cost);
  }
  return map;
}

/** Cutting-register entries (most recent first), for the Cutting Register page. */
export async function loadCuttingRegisters(): Promise<CuttingRegister[]> {
  const supabase = await client();
  const { data } = await supabase
    .from('sd_cutting_register')
    .select('*')
    .order('created_at', { ascending: false })
    .limit(PAGE_SIZE);
  return (data ?? []) as CuttingRegister[];
}

/**
 * PO closures with derived compliance. First syncs closure rows for recently-
 * completed POs (SECURITY DEFINER; the SLA clock starts at completion), then reads
 * and attaches the real-time RAG/SLA (computed, never stored).
 */
export async function loadPoClosures(): Promise<PoClosureView[]> {
  const supabase = await client();
  try {
    await supabase.rpc('sd_sync_po_closures');
  } catch {
    /* best-effort — a sync hiccup must not blank the page */
  }
  const { data } = await supabase
    .from('sd_po_closure')
    .select('*')
    .order('easycom_completed_at', { ascending: false, nullsFirst: false })
    .limit(PAGE_SIZE);
  return ((data ?? []) as PoClosure[]).map((r) => ({
    ...r,
    productCode: r.po_ref_num.split('/')[2]?.trim() || null,
    compliance: computeClosureCompliance(r),
  }));
}

/**
 * Open (not-yet-closed) closures with derived compliance, read-only (NO sync) —
 * for the dashboard's Pending Closure panel. Row creation is handled by the
 * twice-daily BqSync + the /po-closure page, so the high-traffic dashboard stays
 * a pure read.
 */
export async function loadOpenClosures(): Promise<PoClosureView[]> {
  const supabase = await client();
  const { data } = await supabase
    .from('sd_po_closure')
    .select('*')
    .is('closed_at', null)
    .order('easycom_completed_at', { ascending: true, nullsFirst: false })
    .limit(PAGE_SIZE);
  return ((data ?? []) as PoClosure[]).map((r) => ({
    ...r,
    productCode: r.po_ref_num.split('/')[2]?.trim() || null,
    compliance: computeClosureCompliance(r),
  }));
}

/** Cutting-register dynamic links (most recent first). */
export async function loadDynamicLinks(): Promise<DynamicLink[]> {
  const supabase = await client();
  const { data } = await supabase
    .from('sd_dynamic_links')
    .select('*')
    .eq('link_type', 'cutting_register')
    .order('created_at', { ascending: false })
    .limit(PAGE_SIZE);
  return (data ?? []) as DynamicLink[];
}

/** product_code + product_name for the "Add Product" picker (search by either). */
export async function loadProductCatalog(): Promise<ProductCatalogItem[]> {
  const supabase = await client();
  const { data } = await supabase
    .from('sd_product_catalog')
    .select('product_code, product_name, category, sub_category')
    .order('product_code')
    .limit(PAGE_SIZE);
  return (data ?? []) as ProductCatalogItem[];
}

/** Monthly EFOB fabric-cost benchmarks, most recent first (spec §6). */
export async function loadEfobFabricCost(): Promise<EfobFabricCost[]> {
  const supabase = await client();
  const { data } = await supabase
    .from('sd_efob_fabric_cost')
    .select('*')
    .order('month', { ascending: false })
    .limit(24);
  return (data ?? []) as EfobFabricCost[];
}

/** product_code → BOM standard, so the cutting form can show the standard by product. */
export async function loadProductBom(): Promise<Record<string, ProductBom>> {
  const supabase = await client();
  const { data } = await supabase
    .from('sd_product_master')
    .select('product_code, bom_quantity, bom_uom')
    .limit(PAGE_SIZE);
  const map: Record<string, ProductBom> = {};
  for (const r of (data ?? []) as { product_code: string; bom_quantity: number | null; bom_uom: string | null }[]) {
    map[r.product_code] = { bom_quantity: r.bom_quantity, bom_uom: r.bom_uom };
  }
  return map;
}

/** CMTP cost-breakdown line items (all products), for the Standard Cost CMTP view. */
export async function loadCmtpComponents(): Promise<CmtpComponent[]> {
  const supabase = await client();
  const { data } = await supabase
    .from('sd_cmtp_component')
    .select('*')
    .order('product_code')
    .order('position')
    .limit(PAGE_SIZE);
  return (data ?? []) as CmtpComponent[];
}

/**
 * The managed CMTP sub-item master, grouped by head (category → sub-item names).
 * Feeds the sub-item dropdown on the Standard Cost CMTP breakdown so people pick
 * a standardized name instead of free-typing near-duplicates.
 */
export async function loadCmtpSubitems(): Promise<Record<string, string[]>> {
  const supabase = await client();
  const { data } = await supabase
    .from('sd_cmtp_subitem')
    .select('category, name, is_active')
    .eq('is_active', true)
    .order('category')
    .order('name')
    .limit(PAGE_SIZE);
  const map: Record<string, string[]> = {};
  ((data ?? []) as { category: string; name: string }[]).forEach((r) => {
    (map[r.category] ??= []).push(r.name);
  });
  return map;
}

/** Every material-cost row, for the Material tab of the Standard Cost page. */
export async function loadMaterialStandardCosts(): Promise<StandardCost[]> {
  const supabase = await client();
  const { data } = await supabase
    .from('sd_material_standard_cost')
    .select('*')
    .order('product_code')
    .limit(PAGE_SIZE);
  return (data ?? []) as StandardCost[];
}

/** Approved material rates → Map material_code → { job (Job Work), fob (Purchase) }. */
export async function loadApprovedMaterialCosts(): Promise<
  Record<string, { job: number; fob: number }>
> {
  const supabase = await client();
  const { data } = await supabase
    .from('sd_material_standard_cost')
    .select('product_code, job_cost, fob_cost, status')
    .eq('status', 'approved')
    .limit(PAGE_SIZE);
  const map: Record<string, { job: number; fob: number }> = {};
  (
    (data ?? []) as { product_code: string; job_cost: number | null; fob_cost: number | null }[]
  ).forEach((r) => {
    map[r.product_code] = { job: Number(r.job_cost) || 0, fob: Number(r.fob_cost) || 0 };
  });
  return map;
}

/** Approved standard rates per product, for the Buying Plan value calc. */
/**
 * The live standard rate per product = the LATEST ACCEPTED rate, read from the
 * rate-history table (sd_standard_cost_rate_history) so a product being
 * re-negotiated keeps its current rate until a new proposal is accepted. Falls
 * back to any approved working row that predates the history (defensive; the
 * migration backfills all approved rows, so this should be empty).
 */
export async function loadApprovedStandardCosts(): Promise<
  Record<string, { job: number; fob: number; efob: number }>
> {
  const supabase = await client();
  const map: Record<string, { job: number; fob: number; efob: number }> = {};

  // History rows, newest first — first seen per code wins (its latest accepted rate).
  const hist: { product_code: string; job_cost: number | null; fob_cost: number | null; efob_cost: number | null }[] = [];
  for (let from = 0; ; from += PAGE_SIZE) {
    const { data } = await supabase
      .from('sd_standard_cost_rate_history')
      .select('product_code, job_cost, fob_cost, efob_cost')
      .order('accepted_at', { ascending: false })
      .range(from, from + PAGE_SIZE - 1);
    if (!data?.length) break;
    hist.push(...(data as typeof hist));
    if (data.length < PAGE_SIZE) break;
  }
  for (const r of hist) {
    if (map[r.product_code]) continue; // already have the latest for this code
    map[r.product_code] = {
      job: Number(r.job_cost) || 0,
      fob: Number(r.fob_cost) || 0,
      efob: Number(r.efob_cost) || 0,
    };
  }

  // Fallback for any approved row not yet represented in history.
  const { data: approved } = await supabase
    .from('sd_standard_cost')
    .select('product_code, job_cost, fob_cost, efob_cost')
    .eq('status', 'approved')
    .limit(PAGE_SIZE);
  ((approved ?? []) as { product_code: string; job_cost: number | null; fob_cost: number | null; efob_cost: number | null }[]).forEach((r) => {
    if (map[r.product_code]) return;
    map[r.product_code] = {
      job: Number(r.job_cost) || 0,
      fob: Number(r.fob_cost) || 0,
      efob: Number(r.efob_cost) || 0,
    };
  });
  return map;
}

/** Full accepted-rate history per product, newest first — for the Rate History tab. */
export async function loadStandardCostRateHistory(): Promise<Record<string, StandardCostRateHistory[]>> {
  const supabase = await client();
  const rows: StandardCostRateHistory[] = [];
  for (let from = 0; ; from += PAGE_SIZE) {
    const { data, error } = await supabase
      .from('sd_standard_cost_rate_history')
      .select('*')
      .order('accepted_at', { ascending: false })
      .range(from, from + PAGE_SIZE - 1);
    if (error) throw new Error(`sd_standard_cost_rate_history: ${error.message}`);
    if (!data?.length) break;
    rows.push(...(data as StandardCostRateHistory[]));
    if (data.length < PAGE_SIZE) break;
  }
  const byCode: Record<string, StandardCostRateHistory[]> = {};
  for (const r of rows) (byCode[r.product_code] ??= []).push(r);
  return byCode;
}

/**
 * Discontinued-products available inventory (serial-level mirror of the Google
 * Sheet) plus a variant -> 45-day-sales map from sd_variant_sales, so the page
 * can flag the "no sales & >365 days" write-off rule. Rolled up to SKU level in
 * the client via lib/discontinued.ts.
 */
export async function loadDiscontinuedInventory(): Promise<{
  rows: DiscontinuedInventoryRow[];
  salesByVariant: Record<string, number>;
}> {
  const supabase = await client();
  const rows: DiscontinuedInventoryRow[] = [];
  for (let from = 0; ; from += PAGE_SIZE) {
    const { data, error } = await supabase
      .from('discontinued_inventory')
      .select(
        'source_row_key, sku, category, sub_category, product_name, color, size, mrp, cost, product_launch_date, product_state, available_inventory, inventory_status, status, serial_number, inward_date, days_in_warehouse',
      )
      .eq('is_active', true)
      .order('sku', { ascending: true })
      .range(from, from + PAGE_SIZE - 1);
    if (error) throw new Error(`discontinued_inventory: ${error.message}`);
    if (!data?.length) break;
    rows.push(...(data as DiscontinuedInventoryRow[]));
    if (data.length < PAGE_SIZE) break;
  }

  const { data: sales } = await supabase
    .from('sd_variant_sales')
    .select('product_variant, sales_45d');
  const salesByVariant: Record<string, number> = {};
  (
    (sales ?? []) as { product_variant: string | null; sales_45d: number | null }[]
  ).forEach((s) => {
    const v = (s.product_variant ?? '').trim();
    if (v) salesByVariant[v] = Number(s.sales_45d) || 0;
  });

  return { rows, salesByVariant };
}

/** Every provisioned user, for the admin-only User Panel. */
export async function loadUsers(): Promise<SdUser[]> {
  const supabase = await client();
  const [{ data }, { data: assignments }] = await Promise.all([
    supabase
      .from('sd_user')
      .select('email, full_name, role, is_active, last_seen_at')
      .order('is_active', { ascending: false })
      .order('email'),
    supabase.from('sd_user_role').select('user_email, role_id'),
  ]);
  const byEmail = new Map<string, number[]>();
  ((assignments ?? []) as { user_email: string; role_id: number }[]).forEach((a) => {
    byEmail.set(a.user_email, [...(byEmail.get(a.user_email) ?? []), a.role_id]);
  });
  return ((data ?? []) as SdUser[]).map((u) => ({
    ...u,
    custom_role_ids: byEmail.get(u.email) ?? [],
  }));
}

/** Cheap count of items in the shared approval queue, for the notification bell. */
export async function countPendingApprovals(): Promise<number> {
  const supabase = await client();
  const pending = (t: string) =>
    supabase.from(t).select('*', { count: 'exact', head: true }).in('status', ['submitted', 'pending_l2']);
  // Cost negotiation runs outside the status ladder: proposed / rate_submitted
  // are the admin's turn (the bell renders for admins only).
  const costPending = (t: string) =>
    supabase.from(t).select('*', { count: 'exact', head: true }).in('neg_stage', ['proposed', 'rate_submitted']);
  const [a, b, c, d, e] = await Promise.all([
    pending('sd_buying_plan'),
    pending('sd_discontinue_request'),
    pending('sd_po_approval'),
    costPending('sd_standard_cost'),
    costPending('sd_material_standard_cost'),
  ]);
  return (a.count ?? 0) + (b.count ?? 0) + (c.count ?? 0) + (d.count ?? 0) + (e.count ?? 0);
}

/**
 * Lightweight list behind the topbar notification bell: the pending items this
 * user can act on (same three sources as the count), newest first. Deliberately
 * cheap — no cost/vendor enrichment; every link points at /approvals, where the
 * action is taken.
 */
export async function loadApprovalNotifications(role: SdRole): Promise<ApprovalNotification[]> {
  const supabase = await client();
  // Cost rows live outside the status ladder — proposed / rate_submitted are the
  // admin's turn in the negotiation, so they only surface for admins.
  const costTurn = (t: string) =>
    role === 'admin'
      ? supabase
          .from(t)
          .select('id, product_code, status, neg_stage, updated_at')
          .in('neg_stage', ['proposed', 'rate_submitted'])
      : Promise.resolve({ data: [] as never[] });
  const [plans, discontinues, pos, fgCosts, matCosts] = await Promise.all([
    supabase
      .from('sd_buying_plan')
      .select('id, plan_month, plan_type, status, submitted_by, submitted_at')
      .in('status', ['submitted', 'pending_l2']),
    supabase
      .from('sd_discontinue_request')
      .select('id, product_code, product_variant, status, requested_by, requested_at')
      .in('status', ['submitted', 'pending_l2']),
    supabase
      .from('sd_po_approval')
      .select('id, po_ref_num, product_code, category, status, created_by, submitted_for_approval_at')
      .in('status', ['submitted', 'pending_l2']),
    costTurn('sd_standard_cost'),
    costTurn('sd_material_standard_cost'),
  ]);

  const items: ApprovalNotification[] = [];

  for (const p of (plans.data ?? []) as Array<{
    id: number; plan_month: string; plan_type: string | null; status: SdStatus;
    submitted_by: string | null; submitted_at: string | null;
  }>) {
    if (!canApprove(role, p.status)) continue;
    const material = p.plan_type === 'material';
    items.push({
      key: `bp-${p.id}`,
      kind: 'buying_plan',
      label: `${material ? 'Material' : 'FG'} buying plan — ${p.plan_month.slice(0, 7)}`,
      sublabel: 'Buying plan awaiting your approval',
      status: p.status,
      href: '/approvals',
      submittedBy: p.submitted_by,
      submittedAt: p.submitted_at,
    });
  }

  for (const d of (discontinues.data ?? []) as Array<{
    id: number; product_code: string | null; product_variant: string | null; status: SdStatus;
    requested_by: string | null; requested_at: string | null;
  }>) {
    if (!canApprove(role, d.status)) continue;
    items.push({
      key: `dc-${d.id}`,
      kind: 'discontinue',
      label: `Discontinue — ${d.product_code ?? '—'}${d.product_variant ? ` / ${d.product_variant}` : ''}`,
      sublabel: 'Discontinuation awaiting your approval',
      status: d.status,
      href: '/approvals',
      submittedBy: d.requested_by,
      submittedAt: d.requested_at,
    });
  }

  for (const po of (pos.data ?? []) as Array<{
    id: number; po_ref_num: string | null; product_code: string | null; category: string | null;
    status: SdStatus; created_by: string | null; submitted_for_approval_at: string | null;
  }>) {
    if (!canApprove(role, po.status)) continue;
    items.push({
      key: `po-${po.id}`,
      kind: 'po_approval',
      label: `PO — ${po.po_ref_num || po.product_code || `#${po.id}`}`,
      sublabel: `${(po.category ?? 'PO').toUpperCase()} purchase order awaiting your approval`,
      status: po.status,
      href: '/approvals',
      submittedBy: po.created_by,
      submittedAt: po.submitted_for_approval_at,
    });
  }

  type CostNotifRow = { id: number; product_code: string; status: SdStatus; neg_stage: string; updated_at: string | null };
  const costItems = (rows: CostNotifRow[] | null | undefined, material: boolean) => {
    for (const c of (rows ?? []) as CostNotifRow[]) {
      items.push({
        key: `${material ? 'mc' : 'sc'}-${c.id}`,
        kind: 'standard_cost',
        label: `${material ? 'Material' : 'Standard'} cost — ${c.product_code}`,
        sublabel:
          c.neg_stage === 'proposed'
            ? 'Cost proposed — accept, reject or set a target'
            : 'Actual rate submitted — awaiting your sign-off',
        status: c.status,
        href: material
          ? '/standard-cost?track=material'
          : `/standard-cost?open=${encodeURIComponent(c.product_code)}`,
        submittedBy: null,
        submittedAt: c.updated_at,
      });
    }
  };
  costItems(fgCosts.data as CostNotifRow[] | null, false);
  costItems(matCosts.data as CostNotifRow[] | null, true);

  // Newest first; items with no submission timestamp sink to the bottom.
  return items.sort((a, b) => (b.submittedAt ?? '').localeCompare(a.submittedAt ?? ''));
}

/** Per-source data freshness for the Sync Health tab (sd_sync_status view). */
export async function loadSyncStatus(): Promise<SyncStatusRow[]> {
  const supabase = await client();
  const { data, error } = await supabase
    .from('sd_sync_status')
    .select('*')
    .order('pipeline')
    .order('source');
  if (error) throw new Error(`sd_sync_status: ${error.message}`);
  return (data ?? []) as SyncStatusRow[];
}

/**
 * Inward Plan II — the team-filled monthly inward sheet (Buying Plan tab).
 * Returns the month's rows plus the product-master catalog (same source as the
 * Buying Plan's Add-Product picker) so the team types a code straight from the
 * master rather than from the plan.
 */
export async function loadInwardPlanSheet(planMonth: string): Promise<{
  entries: InwardPlanEntry[];
  catalog: ProductCatalogItem[];
}> {
  const supabase = await client();
  const [{ data: entries, error }, catalog] = await Promise.all([
    supabase
      .from('sd_inward_plan_entry')
      .select('*')
      .eq('plan_month', planMonth)
      .order('id'),
    loadProductCatalog(),
  ]);
  if (error) throw new Error(`sd_inward_plan_entry: ${error.message}`);
  const enriched = await enrichInwardWithPoDates((entries ?? []) as InwardPlanEntry[]);
  return { entries: enriched, catalog };
}

/**
 * Item 4: fill each inward entry's EDD + closure date from the PO's own feeds
 * (never re-entered). EDD comes from whichever feed holds the PO (open or
 * completed); the closure date only exists once the PO has completed.
 */
async function enrichInwardWithPoDates(rows: InwardPlanEntry[]): Promise<InwardPlanEntry[]> {
  if (!rows.length) return rows;
  const supabase = await client();
  const poNos = [...new Set(rows.map((e) => (e.po_no ?? '').trim()).filter(Boolean))];
  const poDates = new Map<string, { edd: string | null; closure: string | null }>();
  if (poNos.length) {
    const [openPo, compPo] = await Promise.all([
      supabase.from('pending_po_master').select('po_number, expected_delivery_date').in('po_number', poNos),
      supabase.from('sd_po_completed').select('po_number, expected_delivery_date, po_updated_date').in('po_number', poNos),
    ]);
    for (const r of (openPo.data ?? []) as { po_number: string; expected_delivery_date: string | null }[]) {
      const cur = poDates.get(r.po_number) ?? { edd: null, closure: null };
      cur.edd = cur.edd ?? r.expected_delivery_date ?? null;
      poDates.set(r.po_number, cur);
    }
    // Completed feed wins for EDD (final) and is the only source of a closure date.
    for (const r of (compPo.data ?? []) as {
      po_number: string; expected_delivery_date: string | null; po_updated_date: string | null;
    }[]) {
      const cur = poDates.get(r.po_number) ?? { edd: null, closure: null };
      cur.edd = r.expected_delivery_date ?? cur.edd;
      cur.closure = r.po_updated_date ?? cur.closure;
      poDates.set(r.po_number, cur);
    }
  }
  return rows.map((e) => {
    const d = e.po_no ? poDates.get(e.po_no.trim()) : undefined;
    return { ...e, expected_delivery_date: d?.edd ?? null, po_closure_date: d?.closure ?? null };
  });
}

/**
 * Item 5: company-wide "what's arriving when". The monthly approved inward plan
 * across recent + upcoming months (sd_inward_plan_entry), enriched with each PO's
 * EDD + closure (item 4) and the product's category, for a read-only, filterable
 * cross-department view. Planned = inward_qty, actual = actual_inward_qty.
 */
export async function loadArrivalPlan(): Promise<{
  rows: (InwardPlanEntry & { category: string | null })[];
}> {
  const supabase = await client();
  const [{ data: entries }, catalog] = await Promise.all([
    supabase
      .from('sd_inward_plan_entry')
      .select('*')
      .order('plan_month', { ascending: false })
      .limit(PAGE_SIZE),
    loadProductCatalog(),
  ]);
  const enriched = await enrichInwardWithPoDates((entries ?? []) as InwardPlanEntry[]);
  const catByCode = new Map(catalog.map((c) => [c.product_code, c.category] as const));
  const rows = enriched.map((e) => ({
    ...e,
    category: catByCode.get(e.product_code) ?? null,
  }));
  return { rows };
}

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

/** Full material master (all types) + active colours, for the Material Master page. */
export async function loadMaterialMaster(): Promise<{
  materials: MaterialMaster[];
  colours: Colour[];
  fabricCodes: string[];
}> {
  const supabase = await client();
  const [{ data: materials }, { data: colours }, { data: fabrics }] = await Promise.all([
    supabase.from('sd_material_master').select('*').order('material_type').order('material_code').limit(PAGE_SIZE),
    supabase.from('sd_colour_master').select('colour, is_active').order('colour').limit(PAGE_SIZE),
    supabase.from('sd_fabric_master').select('fabric_code').eq('is_active', true).order('fabric_code').limit(PAGE_SIZE),
  ]);
  return {
    materials: (materials ?? []) as MaterialMaster[],
    colours: (colours ?? []) as Colour[],
    fabricCodes: ((fabrics ?? []) as { fabric_code: string }[]).map((f) => f.fabric_code),
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

/**
 * Receivable Plan — size-pivoted open-PO receivables + DOQ/stock/OOS, merged with
 * the weekly team inputs (delivery date / qty expected / remarks).
 */
export async function loadReceivablePlan(): Promise<ReceivablePlanRow[]> {
  const supabase = await client();
  const rows: Record<string, unknown>[] = [];
  for (let from = 0; ; from += PAGE_SIZE) {
    const { data, error } = await supabase
      .from('sd_receivable_plan')
      .select('*')
      .order('expected_delivery_date', { ascending: true, nullsFirst: false })
      .range(from, from + PAGE_SIZE - 1);
    if (error) throw new Error(`sd_receivable_plan: ${error.message}`);
    if (!data?.length) break;
    rows.push(...(data as Record<string, unknown>[]));
    if (data.length < PAGE_SIZE) break;
  }

  const { data: inputs } = await supabase
    .from('sd_receivable_input')
    .select('row_key, delivery_date_this_week, qty_expected_this_week, remarks, updated_at');
  const inputByKey = new Map(
    ((inputs ?? []) as Record<string, unknown>[]).map((i) => [String(i.row_key), i]),
  );

  // Live TNA/risk status per PO — planned dates from tna_tracker + form actuals,
  // keyed by PO ref (tna.po_no). Same source and rule as the Open PO Tracker.
  const tnaRecords = await loadMergedTnaRecords();
  const tnaByRef = new Map(
    tnaRecords.map((t) => [String(t.po_no ?? '').trim().toLowerCase(), t]),
  );
  const today = istToday();

  // Current stock split by size, from the inventory snapshot. Its SKUs are
  // <product_variant><size> (e.g. SDVCTWH + XS), so size = the SKU tail after
  // the variant prefix. Fetch only the variants present in the plan.
  const stockByVariant = await loadStockByVariantSize(
    supabase,
    [...new Set(rows.map((r) => String(r.product_variant ?? '')).filter(Boolean))],
  );

  return rows.map((r) => {
    const inp = inputByKey.get(String(r.row_key));
    const tna = tnaByRef.get(String(r.po_ref_num ?? '').trim().toLowerCase()) ?? null;
    const edd = parseIsoDate(r.expected_delivery_date as string | null);
    const delayDays = edd ? Math.max(0, daysBetween(today, edd)) : 0;
    const internal_status = computeInternalStatus({
      delayDays,
      highRisk: isTnaHighRisk(tna, today),
    });
    return {
      ...(r as unknown as ReceivablePlanRow),
      internal_status,
      stock_by_size: stockByVariant.get(String(r.product_variant ?? '')) ?? {},
      delivery_date_this_week: (inp?.delivery_date_this_week as string | null) ?? null,
      qty_expected_this_week: (inp?.qty_expected_this_week as number | null) ?? null,
      remarks: (inp?.remarks as string | null) ?? null,
      input_updated_at: (inp?.updated_at as string | null) ?? null,
    };
  });
}

const SIZE_LABEL_TO_KEY: Record<string, string> = {
  XS: 'size_xs', S: 'size_s', M: 'size_m', L: 'size_l', XL: 'size_xl',
  '2XL': 'size_2xl', '3XL': 'size_3xl', '4XL': 'size_4xl', '5XL': 'size_5xl',
};

async function loadStockByVariantSize(
  supabase: Awaited<ReturnType<typeof client>>,
  variants: string[],
): Promise<Map<string, Record<string, number>>> {
  const byVariant = new Map<string, Record<string, number>>();
  // Chunk the variant filter so each response stays under the row cap
  // (≤100 variants × ≤9 sizes < 1000 rows).
  for (let i = 0; i < variants.length; i += 100) {
    const chunk = variants.slice(i, i + 100);
    if (!chunk.length) continue;
    const { data } = await supabase
      .from('sd_inventory_planning')
      .select('sku, product_variant, current_stock')
      .in('product_variant', chunk);
    for (const iv of (data ?? []) as Record<string, unknown>[]) {
      const variant = String(iv.product_variant ?? '');
      const sku = String(iv.sku ?? '');
      const stock = Number(iv.current_stock) || 0;
      if (!variant || !stock || !sku.startsWith(variant)) continue;
      const key = SIZE_LABEL_TO_KEY[sku.slice(variant.length).toUpperCase()];
      if (!key) continue;
      const rec = byVariant.get(variant) ?? {};
      rec[key] = (rec[key] ?? 0) + stock;
      byVariant.set(variant, rec);
    }
  }
  return byVariant;
}

/**
 * Inward Plan — arriving stock from open (Approved) POs, grouped to colour level
 * (po_number × product_code × product_variant) off sd_po_lines_enriched.
 * Only lines with pending qty > 0 (still to arrive). Soonest EDD first.
 */
export async function loadInwardPlan(): Promise<InwardPlanGroup[]> {
  const supabase = await client();
  const rows: Record<string, unknown>[] = [];
  for (let from = 0; ; from += PAGE_SIZE) {
    const { data, error } = await supabase
      .from('sd_po_lines_enriched')
      .select(
        'po_number, po_ref_num, product_code, product_variant, vendor_code, vendor_name, pending_qty, original_qty, expected_delivery_date',
      )
      .eq('po_status_code', 3)
      .gt('pending_qty', 0)
      .range(from, from + PAGE_SIZE - 1);
    if (error) throw new Error(`sd_po_lines_enriched: ${error.message}`);
    if (!data?.length) break;
    rows.push(...(data as Record<string, unknown>[]));
    if (data.length < PAGE_SIZE) break;
  }

  const groups = new Map<string, InwardPlanGroup>();
  for (const r of rows) {
    const po_number = String(r.po_number ?? '');
    const product_code = String(r.product_code ?? '');
    const product_variant = String(r.product_variant ?? '');
    const arriving = Number(r.pending_qty) || 0;
    const ordered = Number(r.original_qty) || 0;
    const edd = (r.expected_delivery_date as string | null) ?? null;
    const k = `${po_number}${product_code}${product_variant}`;
    const g = groups.get(k);
    if (g) {
      g.arriving_qty += arriving;
      g.ordered_qty += ordered;
      if (edd && (!g.expected_delivery_date || edd < g.expected_delivery_date)) {
        g.expected_delivery_date = edd;
      }
    } else {
      groups.set(k, {
        po_number,
        po_ref_num: (r.po_ref_num as string | null) ?? null,
        product_code,
        product_variant,
        vendor_code: String(r.vendor_code ?? ''),
        vendor_name: String(r.vendor_name ?? ''),
        ordered_qty: ordered,
        arriving_qty: arriving,
        expected_delivery_date: edd,
      });
    }
  }

  return [...groups.values()].sort((a, b) => {
    if (!a.expected_delivery_date) return 1;
    if (!b.expected_delivery_date) return -1;
    return a.expected_delivery_date.localeCompare(b.expected_delivery_date);
  });
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

/* ------------------------------------------------------------------ */
/* Vendor capacity                                                     */
/* ------------------------------------------------------------------ */

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

/* ------------------------------------------------------------------ */
/* Discontinue                                                         */
/* ------------------------------------------------------------------ */

export async function loadDiscontinueRequests() {
  const supabase = await client();
  const { data } = await supabase
    .from('sd_discontinue_request')
    .select('*')
    .order('id', { ascending: false })
    .limit(500);

  const { data: variants } = await supabase
    .from('sd_active_variants')
    .select('product_code, product_variant')
    .limit(PAGE_SIZE);

  return {
    requests: (data ?? []) as DiscontinueRequest[],
    variants: (variants ?? []) as { product_code: string; product_variant: string }[],
  };
}

/* ------------------------------------------------------------------ */
/* PO Approval                                                         */
/* ------------------------------------------------------------------ */

/**
 * Everything the PO Approval screen needs: the POs themselves, their cycle-time
 * rows (sd_po_cycle_time), the product/vendor pick-lists for the entry form, and
 * each vendor's live in-process load (sd_vendor_in_process) for the cards.
 */
export async function loadPoApprovals() {
  const supabase = await client();

  const [{ data: pos }, { data: cycle }, { data: variants }, { data: vendors }] = await Promise.all([
    supabase
      .from('sd_po_approval')
      .select('*')
      .order('id', { ascending: false })
      .limit(500),
    supabase.from('sd_po_cycle_time').select('*').limit(500),
    supabase.from('sd_active_variants').select('product_code').limit(PAGE_SIZE),
    supabase
      .from('vendor_master_data')
      .select('vendor_code, vendor_name, is_active')
      .eq('is_active', true)
      .limit(PAGE_SIZE),
  ]);

  const poIds = ((pos ?? []) as PoApproval[]).map((p) => p.id);
  const { data: poLines } = poIds.length
    ? await supabase.from('sd_po_approval_line').select('*').in('po_id', poIds)
    : { data: [] as PoApprovalLine[] };
  const linesByPo = new Map<number, PoApprovalLine[]>();
  ((poLines ?? []) as PoApprovalLine[]).forEach((l) => {
    linesByPo.set(l.po_id, [...(linesByPo.get(l.po_id) ?? []), l]);
  });

  const capacityByVendor = await loadInProcessByVendor();

  const productCodes = [
    ...new Set(
      ((variants ?? []) as { product_code: string }[])
        .map((r) => r.product_code)
        .filter(Boolean),
    ),
  ].sort();

  // Vendor code ↔ name from the vendor master (the source for auto-fill + the
  // "CODE - Full Name" display). Fall back to any codes seen in open POs.
  const vendorNames: Record<string, string> = {};
  ((vendors ?? []) as { vendor_code: string | null; vendor_name: string | null }[]).forEach((v) => {
    const code = (v.vendor_code ?? '').trim();
    if (code) vendorNames[code] = (v.vendor_name ?? '').trim();
  });
  const vendorCodes = [
    ...new Set([...Object.keys(vendorNames), ...capacityByVendor.keys()]),
  ].sort();

  const cycleById = new Map<number, PoCycleTime>();
  ((cycle ?? []) as PoCycleTime[]).forEach((c) => cycleById.set(c.id, c));

  return {
    pos: (pos ?? []) as PoApproval[],
    cycleById,
    linesByPo,
    productCodes,
    vendorCodes,
    vendorNames,
    capacityByVendor,
  };
}

/** Open (issued/approved) POs grouped for the submission/closure table. */
export async function loadPoSubmissions(): Promise<PoSubmissionGroup[]> {
  const supabase = await client();
  const rows: Record<string, unknown>[] = [];
  for (let from = 0; ; from += PAGE_SIZE) {
    const { data } = await supabase
      .from('sd_po_lines_enriched')
      .select(
        'po_number, po_ref_num, vendor_code, vendor_name, product_code, product_variant, size, sku, original_qty, pending_qty, item_price, po_date, expected_delivery_date',
      )
      .eq('po_status_code', 3)
      .range(from, from + PAGE_SIZE - 1);
    if (!data?.length) break;
    rows.push(...(data as Record<string, unknown>[]));
    if (data.length < PAGE_SIZE) break;
  }

  const { data: closures } = await supabase.from('sd_po_closure_decision').select('po_number, status');
  const closureByPo = new Map(
    ((closures ?? []) as { po_number: string; status: SdStatus }[]).map((c) => [
      String(c.po_number),
      c.status,
    ]),
  );

  const groups = new Map<string, PoSubmissionGroup>();
  for (const r of rows) {
    const po = String(r.po_number ?? '');
    if (!po) continue;
    const edd = (r.expected_delivery_date as string | null) ?? null;
    const g =
      groups.get(po) ??
      ({
        po_number: po,
        po_ref_num: (r.po_ref_num as string | null) ?? null,
        vendor_code: (r.vendor_code as string | null) ?? null,
        vendor_name: (r.vendor_name as string | null) ?? null,
        po_date: (r.po_date as string | null) ?? null,
        expected_delivery_date: edd,
        product_codes: [],
        original_qty: 0,
        pending_qty: 0,
        closureStatus: closureByPo.get(po) ?? 'draft',
        lines: [],
      } as PoSubmissionGroup);
    const pc = String(r.product_code ?? '');
    if (pc && !g.product_codes.includes(pc)) g.product_codes.push(pc);
    g.original_qty += Number(r.original_qty) || 0;
    g.pending_qty += Number(r.pending_qty) || 0;
    if (edd && (!g.expected_delivery_date || edd < g.expected_delivery_date)) {
      g.expected_delivery_date = edd;
    }
    g.lines.push({
      sku: (r.sku as string | null) ?? null,
      product_variant: (r.product_variant as string | null) ?? null,
      size: (r.size as string | null) ?? null,
      original_qty: Number(r.original_qty) || 0,
      pending_qty: Number(r.pending_qty) || 0,
      item_price: r.item_price != null ? Number(r.item_price) : null,
      expected_delivery_date: edd,
    });
    groups.set(po, g);
  }
  return [...groups.values()].sort((a, b) =>
    (a.expected_delivery_date ?? '').localeCompare(b.expected_delivery_date ?? ''),
  );
}

/** Standard TNA lead-times (singleton) for the critical-path auto-generate. */
export async function loadTnaLeadtimes(): Promise<TnaLeadtimes> {
  const supabase = await client();
  const { data } = await supabase.from('sd_tna_leadtimes').select('*').eq('id', 1).maybeSingle();
  return (
    (data as TnaLeadtimes | null) ?? {
      id: 1,
      pp_sample_days: null,
      gpt_days: null,
      cutting_days: null,
      inline_qc_days: null,
      first_delivery_days: null,
      po_closing_days: null,
      updated_by: null,
      updated_at: '',
    }
  );
}

/* ------------------------------------------------------------------ */
/* My Dashboard — own-scope pipeline + approvals awaiting me           */
/* ------------------------------------------------------------------ */

/**
 * Everything the signed-in user personally needs to act on:
 *   • submissions — buying plans they submitted that are still in flight
 *     (submitted / pending_l2 / rework / rejected), newest first;
 *   • rework — the subset bounced back to them, surfaced as the persistent
 *     (un-dismissable) Rework notice with the approver's remark inline;
 *   • approvals — items from the shared queue this user is allowed to sign off,
 *     so approvers see their own to-do without visiting /approvals.
 */
export async function loadMyDashboard(
  email: string,
  role: SdRole,
): Promise<MyDashboardData> {
  const supabase = await client();

  const { data: plans } = await supabase
    .from('sd_buying_plan')
    .select(
      'id, plan_month, plan_type, status, submitted_by, submitted_at, rework_notes, reworked_by, reworked_at',
    )
    .eq('submitted_by', email)
    .in('status', ['submitted', 'pending_l2', 'rework', 'rejected'])
    .order('submitted_at', { ascending: false, nullsFirst: false })
    .limit(PAGE_SIZE);

  const submissions: MySubmission[] = (
    (plans ?? []) as Array<
      Pick<BuyingPlan, 'id' | 'plan_month' | 'plan_type' | 'status' | 'submitted_at'> & {
        rework_notes: string | null;
        reworked_by: string | null;
        reworked_at: string | null;
      }
    >
  ).map((p) => {
    const track = p.plan_type === 'material' ? 'material' : 'fg';
    return {
      entityType: 'buying_plan' as const,
      entityId: String(p.id),
      track,
      label: `${track === 'material' ? 'Material' : 'FG'} buying plan — ${p.plan_month.slice(0, 7)}`,
      planMonth: p.plan_month,
      status: p.status,
      submittedAt: p.submitted_at,
      reworkNotes: p.rework_notes,
      reworkedBy: p.reworked_by,
      reworkedAt: p.reworked_at,
      href: `/buying-plan?month=${p.plan_month}${track === 'material' ? '&track=material' : ''}`,
    };
  });

  const rework = submissions.filter((s) => s.status === 'rework');

  // Approvals awaiting this user: reuse the shared queue, keep only what this
  // role can act on right now (team → submitted, admin → +pending_l2).
  const { items } = await loadApprovalQueue();
  const approvals = items.filter((i) => canApprove(role, i.status));

  return { submissions, rework, approvals };
}

/* ------------------------------------------------------------------ */
/* NPD monthly budget — cap (admin-set) vs consumption (NPD POs)       */
/* ------------------------------------------------------------------ */

/**
 * The NPD budget picture for a month: the flat cap Sourcing set (or null =
 * "not set yet", never a fake number) against live consumption computed from
 * NPD purchase orders (sd_po_approval, category = 'npd'). Approved POs are the
 * committed spend; submitted/pending ones are shown separately as in-flight.
 */
export async function loadNpdBudget(month = monthStart()): Promise<NpdBudget> {
  const supabase = await client();
  const next = addMonths(month, 1);

  const [{ data: budget }, { data: pos }] = await Promise.all([
    supabase.from('sd_npd_budget').select('*').eq('plan_month', month).maybeSingle(),
    supabase
      .from('sd_po_approval')
      .select('po_qty, rate, status, approved_at, submitted_for_approval_at, timestamp_created')
      .eq('category', 'npd'),
  ]);

  let spent = 0;
  let spentCount = 0;
  let pending = 0;
  let pendingCount = 0;
  let missingRate = 0;

  const inMonth = (ts: string | null) => {
    if (!ts) return false;
    const d = ts.slice(0, 10); // YYYY-MM-DD — lexicographic compare is date-correct
    return d >= month && d < next;
  };

  for (const p of (pos ?? []) as Array<{
    po_qty: number | null;
    rate: number | null;
    status: SdStatus;
    approved_at: string | null;
    submitted_for_approval_at: string | null;
    timestamp_created: string | null;
  }>) {
    const value = Number(p.po_qty || 0) * Number(p.rate || 0);
    if (p.status === 'approved') {
      if (inMonth(p.approved_at)) {
        spent += value;
        spentCount += 1;
        if (p.rate == null) missingRate += 1;
      }
    } else if (p.status === 'submitted' || p.status === 'pending_l2') {
      if (inMonth(p.submitted_for_approval_at ?? p.timestamp_created)) {
        pending += value;
        pendingCount += 1;
      }
    }
  }

  const cap =
    budget && (budget as { cap_amount: number | null }).cap_amount != null
      ? Number((budget as { cap_amount: number }).cap_amount)
      : null;

  return {
    month,
    cap,
    note: (budget as { note: string | null } | null)?.note ?? null,
    updatedBy: (budget as { updated_by: string | null } | null)?.updated_by ?? null,
    updatedAt: (budget as { updated_at: string | null } | null)?.updated_at ?? null,
    spent,
    spentCount,
    pending,
    pendingCount,
    missingRate,
  };
}

/* ------------------------------------------------------------------ */
/* Approvals queue                                                     */
/* ------------------------------------------------------------------ */

export async function loadApprovalQueue(): Promise<{
  items: ApprovalQueueItem[];
  log: ApprovalLogRow[];
}> {
  const supabase = await client();

  // Cost negotiation runs outside the status ladder (neg_stage), but the admin's
  // turns — a fresh proposal (proposed) and an actual rate awaiting sign-off
  // (rate_submitted) — surface here too, as link-outs to /standard-cost.
  const [
    { data: plans },
    { data: discontinues },
    { data: pos },
    { data: fgCostReqs },
    { data: log },
  ] = await Promise.all([
    supabase.from('sd_buying_plan').select('*').in('status', ['submitted', 'pending_l2']),
    supabase
      .from('sd_discontinue_request')
      .select('*')
      .in('status', ['submitted', 'pending_l2']),
    supabase.from('sd_po_approval').select('*').in('status', ['submitted', 'pending_l2']),
    supabase
      .from('sd_standard_cost')
      .select('id, product_code, neg_stage, job_cost, fob_cost, efob_cost, proposed_cost, updated_at')
      .in('neg_stage', ['proposed', 'rate_submitted']),
    supabase
      .from('sd_approval_log')
      .select('*')
      .order('created_at', { ascending: false })
      .limit(100),
  ]);

  const items: ApprovalQueueItem[] = [];

  // Per-line value on the approvals cards uses the same approved standard costs
  // the buying-plan grid values with (per-PO-type rate × its quantity). Material
  // plans value against the approved MATERIAL standard cost (job / purchase),
  // not the FG standard cost — loaded only when a material plan is in the queue.
  const anyMaterial = (plans ?? []).some((p) => (p as BuyingPlan).plan_type === 'material');
  const stdCosts: Record<string, { job: number; fob: number; efob: number }> =
    (plans ?? []).length ? await loadApprovedStandardCosts() : {};
  const matCosts: Record<string, { job: number; fob: number }> = anyMaterial
    ? await loadApprovedMaterialCosts()
    : {};
  const MATERIAL_GROUP: Record<string, string> = {
    raw: 'Raw material',
    dyed: 'Dyed / finished',
    trim: 'Trims',
  };

  // Weave on approval lines is sourced from the product master (live), not the
  // line's stored fabric_type snapshot — one weave source across the project.
  const weaveByCode: Record<string, string> = {};
  if ((plans ?? []).length) {
    const { data: wv } = await supabase
      .from('sd_ee_product_code_status')
      .select('product_code, fabric_type');
    ((wv ?? []) as { product_code: string | null; fabric_type: string | null }[]).forEach((r) => {
      if (r.product_code && r.fabric_type) weaveByCode[r.product_code] = r.fabric_type;
    });
  }

  for (const plan of (plans ?? []) as BuyingPlan[]) {
    const isMaterial = plan.plan_type === 'material';
    const { data: lines } = await supabase
      .from('sd_buying_plan_line')
      .select('id, product_code, fabric_type, material_type, line_status, job_work_qty, fob_qty, efob_qty')
      .eq('plan_id', plan.id);
    const lineRows = (lines ?? []) as (BuyingPlanLine & { material_type: string | null })[];
    const qty = lineRows.reduce(
      (sum, l) =>
        sum +
        Number(l.job_work_qty || 0) +
        Number(l.fob_qty || 0) +
        Number(l.efob_qty || 0),
      0,
    );
    items.push({
      entityType: 'buying_plan',
      entityId: String(plan.id),
      track: isMaterial ? 'material' : 'fg',
      label: `${isMaterial ? 'Material buying plan' : 'Buying plan'} — ${plan.plan_month.slice(0, 7)}`,
      sublabel: `${lineRows.length} ${isMaterial ? 'material codes' : 'product codes'} · ${qty.toLocaleString('en-IN')} pcs`,
      status: plan.status,
      quantity: qty,
      requiredRole: routeApproval('buying_plan', qty),
      submittedBy: plan.submitted_by,
      submittedAt: plan.submitted_at,
      href: `/buying-plan?month=${plan.plan_month}${isMaterial ? '&track=material' : ''}`,
      lines: lineRows.map((l) => {
        const job = Number(l.job_work_qty || 0);
        const fob = Number(l.fob_qty || 0);
        const efob = Number(l.efob_qty || 0);
        const lineQty = job + fob + efob;
        // Material lines value against the material standard cost (job / purchase,
        // no EFOB) and group by material type; FG lines value against the FG
        // standard cost and group by live weave.
        let value: number;
        let fabricType: string | null;
        if (isMaterial) {
          const cost = matCosts[l.product_code ?? ''];
          value = cost ? job * cost.job + fob * cost.fob : 0;
          fabricType = MATERIAL_GROUP[l.material_type ?? ''] ?? 'Material';
        } else {
          const cost = stdCosts[l.product_code ?? ''];
          value = cost ? job * cost.job + fob * cost.fob + efob * cost.efob : 0;
          fabricType = (l.product_code ? weaveByCode[l.product_code] : undefined) ?? l.fabric_type ?? null;
        }
        return {
          id: String(l.id),
          label: `${l.product_code ?? '—'} · ${lineQty.toLocaleString('en-IN')} pcs`,
          qty: lineQty,
          value,
          fabricType,
          lineStatus: (l.line_status ?? null) as SdStatus | null,
        };
      }),
    });
  }

  for (const req of (discontinues ?? []) as DiscontinueRequest[]) {
    items.push({
      entityType: 'discontinue',
      entityId: String(req.id),
      label: `Discontinue — ${req.product_code} / ${req.product_variant}`,
      sublabel: req.reason ?? 'No reason given',
      status: req.status,
      quantity: 0,
      requiredRole: routeApproval('discontinue'),
      submittedBy: req.requested_by,
      submittedAt: req.requested_at,
      href: '/discontinue',
    });
  }

  // Standard-cost negotiation items awaiting the admin. Actioned on /standard-cost
  // (accept / reject / set target / sign off) — surfaced here as a link-out. Status
  // is set to pending_l2 so the shared "awaiting me" (admin) filter picks them up.
  for (const c of (fgCostReqs ?? []) as {
    id: number; product_code: string; neg_stage: string;
    job_cost: number | null; fob_cost: number | null; efob_cost: number | null;
    proposed_cost: number | null; updated_at: string | null;
  }[]) {
    const rates = [
      c.job_cost != null ? `Job ${c.job_cost}` : null,
      c.fob_cost != null ? `FOB ${c.fob_cost}` : null,
      c.efob_cost != null ? `E-FOB ${c.efob_cost}` : null,
      c.proposed_cost != null ? `expected ${c.proposed_cost}` : null,
    ].filter(Boolean).join(' · ');
    const proposed = c.neg_stage === 'proposed';
    items.push({
      entityType: 'standard_cost',
      entityId: String(c.id),
      label: `Standard cost — ${c.product_code}`,
      sublabel:
        (proposed ? 'Rate proposed — accept, reject or set a target' : 'Actual rate submitted — sign off') +
        (rates ? ` · ${rates}` : ''),
      status: 'pending_l2', // cost always needs admin (routeApproval)
      quantity: 0,
      requiredRole: 'admin',
      submittedBy: null,
      submittedAt: c.updated_at,
      href: `/standard-cost?open=${encodeURIComponent(c.product_code)}`,
    });
  }

  if ((pos ?? []).length) {
    const poList = (pos ?? []) as PoApproval[];
    const [inProcessByVendor, latestCapacity, stdCosts] = await Promise.all([
      loadInProcessByVendor(),
      loadLatestVendorCapacity(),
      loadApprovedStandardCosts(),
    ]);
    // Product-level inventory snapshot (DOQ / stock / days) for the PO products.
    const poCodes = [...new Set(poList.map((p) => p.product_code).filter(Boolean))] as string[];
    const invByProduct: Record<string, { stock: number; inProgress: number; daily: number; doq45: number }> = {};
    if (poCodes.length) {
      const { data: inv } = await supabase
        .from('sd_inventory_by_product')
        .select('product_code, current_stock, total_inprogress, daily_quantity, doq_45')
        .in('product_code', poCodes);
      for (const r of (inv ?? []) as Record<string, unknown>[]) {
        invByProduct[String(r.product_code)] = {
          stock: Number(r.current_stock) || 0,
          inProgress: Number(r.total_inprogress) || 0,
          daily: Number(r.daily_quantity) || 0,
          doq45: Number(r.doq_45) || 0,
        };
      }
    }

    // Standard CM (CMTP total) + standard finished-fabric per product — the
    // benchmarks the PO cost-pivot compares against (spec §5). CM gates approval;
    // finished fabric is shown for awareness only.
    const stdCmByCode: Record<string, number> = {};
    const stdFabricByCode: Record<string, number> = {};
    if (poCodes.length) {
      const { data: scRows } = await supabase
        .from('sd_standard_cost')
        .select('product_code, cm_cost, fabric_code')
        .in('product_code', poCodes);
      const fabricCodes = [
        ...new Set(
          ((scRows ?? []) as { fabric_code: string | null }[])
            .map((r) => r.fabric_code)
            .filter(Boolean) as string[],
        ),
      ];
      const fabricRate: Record<string, number> = {};
      if (fabricCodes.length) {
        const { data: fb } = await supabase
          .from('sd_fabric_cost_base')
          .select('fabric_code, finished_fabric_cost')
          .in('fabric_code', fabricCodes);
        for (const r of (fb ?? []) as { fabric_code: string; finished_fabric_cost: number | null }[]) {
          if (r.finished_fabric_cost != null) fabricRate[r.fabric_code] = Number(r.finished_fabric_cost);
        }
      }
      for (const r of (scRows ?? []) as {
        product_code: string;
        cm_cost: number | null;
        fabric_code: string | null;
      }[]) {
        if (r.cm_cost != null) stdCmByCode[r.product_code] = Number(r.cm_cost);
        if (r.fabric_code && fabricRate[r.fabric_code] != null) {
          stdFabricByCode[r.product_code] = fabricRate[r.fabric_code];
        }
      }
    }

    for (const po of poList) {
      const qty = Number(po.po_qty || 0);
      const vendor = (po.vendor_code ?? '').trim();
      const { data: poLines } = await supabase
        .from('sd_po_approval_line')
        .select('id, product_variant, size, qty')
        .eq('po_id', po.id);
      const cap = vendor ? latestCapacity.get(vendor.toLowerCase()) : undefined;
      const stdCost = po.product_code ? stdCosts[po.product_code] ?? null : null;
      const inv = po.product_code ? invByProduct[po.product_code] ?? null : null;
      items.push({
        entityType: 'po_approval',
        entityId: String(po.id),
        label: `PO ${po.po_ref_num ?? `#${po.id}`} — ${po.category.toUpperCase()}`,
        sublabel: `${po.product_code ?? '—'} · ${po.vendor_name || vendor || '—'} · ${qty.toLocaleString('en-IN')} pcs`,
        status: po.status,
        quantity: qty,
        requiredRole: routeApproval('po_approval', qty, po.category),
        submittedBy: po.created_by,
        submittedAt: po.submitted_for_approval_at,
        href: '/po-approval',
        vendorCode: vendor || null,
        vendorInProcessQty: vendor
          ? inProcessByVendor.get(vendor.toLowerCase()) ?? null
          : null,
        vendorCapacityPerMonth: cap?.capacityPerMonth ?? null,
        vendorCapacityUpdatedAt: cap?.weekOf ?? null,
        lines: ((poLines ?? []) as { id: number; product_variant: string | null; size: string | null; qty: number | null }[]).map((l) => ({
          id: String(l.id),
          label: `${l.product_variant ?? '—'}${l.size ? ' / ' + l.size : ''} · ${Number(l.qty || 0).toLocaleString('en-IN')} pcs`,
        })),
        poDetail: {
          productCode: po.product_code,
          poType: po.po_type,
          poQty: qty,
          writtenRate: po.rate,
          stdCost,
          poCm: po.cm_cost,
          stdCm: po.product_code ? stdCmByCode[po.product_code] ?? null : null,
          poGrey: po.grey_cost,
          poFinishedFabric: po.finished_fabric_cost,
          stdFinishedFabric: po.product_code ? stdFabricByCode[po.product_code] ?? null : null,
          marginPct: po.margin_pct,
          inventory: inv
            ? {
                currentStock: inv.stock,
                inProgress: inv.inProgress,
                dailyQty: inv.daily,
                doq45: inv.doq45,
                daysOfStock: inv.daily > 0 ? Math.round(inv.stock / inv.daily) : null,
              }
            : null,
          tna: {
            poClosingDate: po.po_closing_date,
            ppSampleDue: po.cs_pp_sample_due,
            gptDue: po.cs_gpt_due,
            cuttingStart: po.cs_cutting_start,
            inlineQcDue: po.cs_inline_qc_due,
            firstDelivery: po.critical_path_first_delivery,
            requestedTotalDays: po.requested_total_days,
            tnaConfirmed: po.tna_confirmed,
          },
        },
      });
    }
  }

  const { count: recCount } = await supabase
    .from('sd_receivable_input')
    .select('row_key', { count: 'exact', head: true })
    .eq('status', 'submitted');
  if (recCount) {
    items.push({
      entityType: 'receivable_plan',
      entityId: 'batch',
      label: `Receivable plan — ${recCount} row(s)`,
      sublabel: 'Weekly receiving inputs submitted for approval',
      status: 'submitted',
      quantity: recCount,
      requiredRole: routeApproval('receivable_plan'),
      submittedBy: null,
      submittedAt: null,
      href: '/receivable-plan',
    });
  }
  items.sort((a, b) => (b.submittedAt ?? '').localeCompare(a.submittedAt ?? ''));
  return { items, log: (log ?? []) as ApprovalLogRow[] };
}

/** Exact, all-time %-of-approvals-that-needed-edits across the record entities. */
export async function loadApprovalStats(): Promise<{ approved: number; edited: number; pct: number }> {
  const supabase = await client();
  const tables = ['sd_buying_plan', 'sd_po_approval', 'sd_standard_cost', 'sd_discontinue_request'];
  const counts = await Promise.all(
    tables.flatMap((t) => [
      supabase.from(t).select('id', { count: 'exact', head: true }).eq('status', 'approved'),
      supabase
        .from(t)
        .select('id', { count: 'exact', head: true })
        .eq('status', 'approved')
        .eq('edited_before_approval', true),
    ]),
  );
  let approved = 0;
  let edited = 0;
  for (let i = 0; i < counts.length; i += 2) {
    approved += counts[i].count ?? 0;
    edited += counts[i + 1].count ?? 0;
  }
  return { approved, edited, pct: approved ? Math.round((edited / approved) * 100) : 0 };
}
