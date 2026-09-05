import 'server-only';
import { client, PAGE_SIZE } from './_shared';
import { productClassOf } from '@/lib/doq-dashboard';
import { loadApprovedStandardCosts } from './standard-cost';
import type { AnalyticsExtras, AnalyticsRuleRow } from '../types';

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
// The snapshot is one row per IST day (sd_record_tna_snapshot upserts ON CONFLICT
// (snapshot_date) DO NOTHING). Every dashboard load used to fire that write RPC even
// though only the first load of the day changes anything. This per-instance guard
// remembers the last IST date this warm instance recorded and skips the DB round-trip
// entirely thereafter; the RPC's ON CONFLICT still guarantees correctness across the
// many ephemeral instances (a cold instance simply writes once, then no-ops).
let lastSnapshotIstDate: string | null = null;

function istDateKey(): string {
  // en-CA gives YYYY-MM-DD; Asia/Kolkata matches the RPC's snapshot_date.
  return new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Kolkata' });
}

export async function recordTnaSnapshot(counts: {
  onTime: number;
  highRisk: number;
  overdue: number;
  openTotal: number;
}): Promise<void> {
  const today = istDateKey();
  if (lastSnapshotIstDate === today) return; // already recorded today on this instance
  try {
    const supabase = await client();
    await supabase.rpc('sd_record_tna_snapshot', {
      p_on_time: counts.onTime,
      p_high_risk: counts.highRisk,
      p_overdue: counts.overdue,
      p_open_total: counts.openTotal,
    });
    lastSnapshotIstDate = today; // only mark done if the RPC didn't throw
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
  const twoWeeksAgoIso = new Date(Date.now() - 14 * 86_400_000).toISOString();
  const weekAgoDate = weekAgoIso.slice(0, 10);
  const todayDate = new Date().toISOString().slice(0, 10);

  /* POs issued this week vs the immediately preceding week (item 1: week-over-week,
     not a flat rolling count). Fetch a 14-day window and partition on po_issued_at. */
  try {
    const { data } = await supabase
      .from('sd_po_approval')
      .select('po_ref_num, po_qty, vendor_name, po_issued_at')
      .gte('po_issued_at', twoWeeksAgoIso)
      .order('po_issued_at', { ascending: false });
    const rows = (data ?? []) as {
      po_ref_num: string | null; po_qty: number | null; vendor_name: string | null; po_issued_at: string | null;
    }[];
    const thisWeek = rows.filter((r) => (r.po_issued_at ?? '') >= weekAgoIso);
    const priorWeek = rows.filter((r) => (r.po_issued_at ?? '') < weekAgoIso);
    const qtyOf = (rs: typeof rows) => rs.reduce((s, r) => s + (Number(r.po_qty) || 0), 0);
    const pctChange = (now: number, prev: number) =>
      prev > 0 ? Math.round(((now - prev) / prev) * 100) : now > 0 ? null : 0;
    const thisQty = qtyOf(thisWeek);
    const priorQty = qtyOf(priorWeek);
    extras.issuedLastWeek = {
      count: thisWeek.length,
      qty: thisQty,
      top: thisWeek.slice(0, 5).map((r) => ({
        poRef: r.po_ref_num ?? '—',
        qty: Number(r.po_qty) || 0,
        vendor: r.vendor_name ?? '—',
      })),
      prior: { count: priorWeek.length, qty: priorQty },
      delta: {
        count: thisWeek.length - priorWeek.length,
        qty: thisQty - priorQty,
        countPct: pctChange(thisWeek.length, priorWeek.length),
        qtyPct: pctChange(thisQty, priorQty),
      },
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
