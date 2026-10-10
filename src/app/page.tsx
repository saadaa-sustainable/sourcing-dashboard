import { redirect } from 'next/navigation';
import { DashboardShell } from '@/components/dashboard-shell';
import { loadDashboardData } from '@/lib/data';
import { isFixtureMode } from '@/lib/supabase/server';
import {
  ANALYTICS_RULE_DEFAULTS,
  currentUser,
  loadAnalyticsExtras,
  loadAnalyticsRules,
  loadOpenClosures,
  recordTnaSnapshot,
} from '@/lib/forms/queries';
import { buildTrackerRows } from '@/lib/business-logic';
import { countOpenIssues, syncAutoIssues } from '@/lib/issues.server';
import { loadPoHub, type PoHubData } from '@/lib/po-hub.server';
import { loadProductHub, type ProductHubData } from '@/lib/product-hub.server';
import { loadVendorHub, type VendorHubData } from '@/lib/vendor-hub.server';
import { loadBuyingPlanAnalysis, loadOosSummary, recordOosSnapshot } from '@/lib/forms/queries';
import type { AnalyticsExtras, PoClosureView, SdRole } from '@/lib/forms/types';

export const dynamic = 'force-dynamic';

// Per-section load times for the home page, logged once per render ("[perf] home …" in the
// Vercel runtime logs). The page is the heaviest in the app; this is how it is tuned.
function timed<T>(times: Record<string, number>, label: string, p: Promise<T>): Promise<T> {
  const t0 = Date.now();
  return p.finally(() => {
    times[label] = Date.now() - t0;
  });
}

export default async function Home() {
  const times: Record<string, number> = {};
  const started = Date.now();
  let userEmail: string | null = null;
  // Local fixture mode (no Supabase env) has no auth — show the full nav. In
  // production, isFixtureMode() THROWS on missing env so a misconfigured deploy
  // fails closed instead of serving a no-login admin dashboard.
  let role: SdRole = 'admin';
  let allowedPages: string[] | null = null;
  const fixtureMode = isFixtureMode();
  if (!fixtureMode) {
    const user = await timed(times, 'user', currentUser());
    if (!user) redirect('/login');
    userEmail = user.email;
    if (!userEmail.endsWith('@saadaa.in')) redirect('/login?error=This+dashboard+is+restricted+to+SAADAA+accounts.');
    role = user.role;
    allowedPages = user.allowed_pages ?? null;
  }
  // Everything below that does not need another result runs at the same time. Shared loaders
  // (dashboard data, rules) are request-cached, so the issue check reuses the same read.
  const dashPromise = timed(times, 'dashboardData', loadDashboardData());
  let dashboardData: Awaited<typeof dashPromise>;
  // Pending-closure panel on the PO Tracker (best-effort — never block the dashboard).
  let closures: PoClosureView[] = [];
  let analyticsRules = ANALYTICS_RULE_DEFAULTS;
  let analyticsExtras: AnalyticsExtras | null = null;
  // The one-pagers that are now sub-tabs of PO Tracker / Product Tracker / Vendor Performance.
  let poHub: PoHubData | null = null;
  let productHub: ProductHubData | null = null;
  let vendorHub: VendorHubData | null = null;
  if (fixtureMode) {
    dashboardData = await dashPromise;
  } else {
    const [dash, closuresR, rulesR, openIssues, plan, oos] = await Promise.all([
      dashPromise,
      timed(times, 'closures', loadOpenClosures()).catch(() => [] as PoClosureView[]),
      timed(times, 'rules', loadAnalyticsRules()), // never throws
      // Part 3 — the dashboard raises its own issues from its checks (missing TNA, no
      // delivery date, discontinued product on order, stale feed) and closes them when the
      // condition is gone; the Objectives tab then shows the open count. Best-effort.
      timed(times, 'autoIssues', syncAutoIssues().catch(() => undefined).then(() => countOpenIssues())),
      // Buying Plan synopsis for the month — the same analysis the Buying Plan Analysis page runs.
      timed(times, 'buyingPlan', loadBuyingPlanAnalysis()).catch(() => null),
      // Spec 1.10 — in-stock rate for yesterday, taken from the DOQ dashboard's own summary
      // (Main Warehouse, on-sale SKUs, exclusions applied) rather than counted a second way,
      // so the headline here and the OOS one-pager cannot disagree.
      timed(times, 'oosSummary', loadOosSummary())
        .then(async (o) => {
          // The OOS trend is one point per data day, saved the first time the position is
          // computed that day. The home page is opened far more often than the DOQ dashboard,
          // so recording here too is what keeps the trend from having gaps (22-25 Sep 2026
          // were lost because nobody opened the DOQ page). Idempotent per data day.
          if (o) await recordOosSnapshot(o.asOf, [o.all, ...o.categories]);
          return o;
        })
        .catch(() => undefined),
    ]);
    dashboardData = dash;
    closures = closuresR;
    analyticsRules = rulesR;

    // Cross-tab card sections (replenishment gaps, plan realization, closure SLA, cost
    // variance, discontinued check) — each section best-effort. Runs alongside the daily
    // TNA-status snapshot; both only need the PO data.
    const [extrasR] = await Promise.all([
      // Only lines with quantity still to arrive count as "on order" — a fully
      // received line must not mark a zero-stock variant as covered.
      timed(times, 'extras', loadAnalyticsExtras(
        dashboardData.pendingPos
          .filter((p) => (Number(p.pending_qty_actual) || 0) > 0)
          .map((p) => ({
            code: (p.product_code ?? '').trim(),
            variant: (p.product_variant ?? '').trim(),
            qty: Number(p.pending_qty_actual) || 0,
          })),
        analyticsRules,
      )).catch(() => null),
      // Daily TNA-status snapshot for the compliance-trend card: first load of the
      // day records the mix; later loads are DB-side no-ops. Best-effort.
      (async () => {
        const rows = buildTrackerRows(
          dashboardData.pendingPos, dashboardData.vendorTypes,
          dashboardData.vendorMasters, dashboardData.tnaRecords,
        );
        await recordTnaSnapshot({
          onTime: rows.filter((r) => r.internalStatus === 'On Track').length,
          highRisk: rows.filter((r) => r.internalStatus === 'High Risk').length,
          overdue: rows.filter((r) => r.internalStatus === 'Overdue').length,
          openTotal: rows.length,
        });
      })().catch(() => undefined),
    ]);
    analyticsExtras = extrasR;

    if (analyticsExtras) {
      analyticsExtras.openIssues = openIssues;
      if (plan) {
        const by = (st: string) => plan.products.filter((p) => p.status === st).length;
        analyticsExtras.planSynopsis = {
          month: plan.planMonth.slice(0, 7),
          hasPlan: plan.hasPlan,
          plannedQty: plan.metrics.plannedQty,
          issuedQty: plan.metrics.issuedQty,
          pendingQty: Math.max(0, plan.metrics.plannedQty - plan.metrics.issuedQty),
          plannedProducts: plan.metrics.approvedProducts,
          onPlan: by('on_plan'),
          over: by('over'),
          short: by('short'),
          unissued: by('unissued'),
          notInPlan: by('not_planned') + by('not_approved'),
          issuedProducts: plan.metrics.issuedProducts,
        };
      } else {
        analyticsExtras.planSynopsis = null;
      }
      // undefined = the summary failed (card hidden); null = no data yet.
      if (oos !== undefined) {
        analyticsExtras.inStock = oos
          ? {
              // pctYesterday is a FRACTION (0.055 = 5.5% of SKUs empty), as the OOS
              // one-pager formats it with × 100 — so in-stock is 1 − it, not 100 − it.
              // (100 − 0.055 read as 99.9% on the live dashboard beside "2,342 of 2,479".)
              ratePct: Math.round((1 - oos.all.pctYesterday) * 1000) / 10,
              oosSkus: oos.all.oosYesterday,
              skus: oos.all.skus,
              asOf: oos.asOf,
            }
          : null;
      } else {
        analyticsExtras.inStock = null;
      }
    }
    // Sub-tab data, built from what is already loaded above; each best-effort.
    const [ph, prh, vh] = await Promise.allSettled([
      timed(times, 'poHub', loadPoHub({ dash: dashboardData, rules: analyticsRules, extras: analyticsExtras })),
      timed(times, 'productHub', loadProductHub({ dash: dashboardData, rules: analyticsRules, extras: analyticsExtras })),
      timed(times, 'vendorHub', loadVendorHub(180, { dash: dashboardData })),
    ]);
    poHub = ph.status === 'fulfilled' ? ph.value : null;
    productHub = prh.status === 'fulfilled' ? prh.value : null;
    vendorHub = vh.status === 'fulfilled' ? vh.value : null;
    times.total = Date.now() - started;
    console.log(`[perf] home ${JSON.stringify(times)}`);
  }
  return (
    <DashboardShell
      data={dashboardData}
      closures={closures}
      userEmail={userEmail}
      role={role}
      allowedPages={allowedPages}
      analyticsRules={analyticsRules}
      analyticsExtras={analyticsExtras}
      poHub={poHub}
      productHub={productHub}
      vendorHub={vendorHub}
    />
  );
}
