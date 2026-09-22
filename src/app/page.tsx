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
import { loadBuyingPlanAnalysis } from '@/lib/forms/queries';
import type { AnalyticsExtras, PoClosureView, SdRole } from '@/lib/forms/types';

export const dynamic = 'force-dynamic';

export default async function Home() {
  let userEmail: string | null = null;
  // Local fixture mode (no Supabase env) has no auth — show the full nav. In
  // production, isFixtureMode() THROWS on missing env so a misconfigured deploy
  // fails closed instead of serving a no-login admin dashboard.
  let role: SdRole = 'admin';
  let allowedPages: string[] | null = null;
  const fixtureMode = isFixtureMode();
  if (!fixtureMode) {
    const user = await currentUser();
    if (!user) redirect('/login');
    userEmail = user.email;
    if (!userEmail.endsWith('@saadaa.in')) redirect('/login?error=This+dashboard+is+restricted+to+SAADAA+accounts.');
    role = user.role;
    allowedPages = user.allowed_pages ?? null;
  }
  const dashboardData = await loadDashboardData();
  // Pending-closure panel on the PO Tracker (best-effort — never block the dashboard).
  let closures: PoClosureView[] = [];
  let analyticsRules = ANALYTICS_RULE_DEFAULTS;
  let analyticsExtras: AnalyticsExtras | null = null;
  // The one-pagers that are now sub-tabs of PO Tracker / Product Tracker / Vendor Performance.
  let poHub: PoHubData | null = null;
  let productHub: ProductHubData | null = null;
  let vendorHub: VendorHubData | null = null;
  if (!fixtureMode) {
    try { closures = await loadOpenClosures(); } catch { closures = []; }
    analyticsRules = await loadAnalyticsRules(); // never throws
    // Cross-tab card sections (replenishment gaps, plan realization, closure
    // SLA, cost variance, discontinued check) — each section best-effort.
    try {
      // Only lines with quantity still to arrive count as "on order" — a fully
      // received line must not mark a zero-stock variant as covered.
      analyticsExtras = await loadAnalyticsExtras(
        dashboardData.pendingPos
          .filter((p) => (Number(p.pending_qty_actual) || 0) > 0)
          .map((p) => ({
            code: (p.product_code ?? '').trim(),
            variant: (p.product_variant ?? '').trim(),
            qty: Number(p.pending_qty_actual) || 0,
          })),
        analyticsRules,
      );
    } catch { analyticsExtras = null; }
    // Daily TNA-status snapshot for the compliance-trend card: first load of the
    // day records the mix; later loads are DB-side no-ops. Best-effort.
    try {
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
    } catch { /* snapshot must never block the dashboard */ }
    // Part 3 — the dashboard raises its own issues from its checks (missing TNA, no
    // delivery date, discontinued product on order, stale feed) and closes them when the
    // condition is gone; the Objectives tab then shows the open count. Best-effort.
    try { await syncAutoIssues(); } catch { /* never block the dashboard */ }
    if (analyticsExtras) analyticsExtras.openIssues = await countOpenIssues();
    // Buying Plan synopsis for the month — the same analysis the Buying Plan Analysis page runs.
    if (analyticsExtras) {
      try {
        const a = await loadBuyingPlanAnalysis();
        const by = (s: string) => a.products.filter((p) => p.status === s).length;
        analyticsExtras.planSynopsis = {
          month: a.planMonth.slice(0, 7),
          hasPlan: a.hasPlan,
          plannedQty: a.metrics.plannedQty,
          issuedQty: a.metrics.issuedQty,
          pendingQty: Math.max(0, a.metrics.plannedQty - a.metrics.issuedQty),
          plannedProducts: a.metrics.approvedProducts,
          onPlan: by('on_plan'),
          over: by('over'),
          short: by('short'),
          unissued: by('unissued'),
          notInPlan: by('not_planned') + by('not_approved'),
          issuedProducts: a.metrics.issuedProducts,
        };
      } catch { analyticsExtras.planSynopsis = null; }
    }
    // Sub-tab data, built from what is already loaded above; each best-effort.
    const [ph, prh, vh] = await Promise.allSettled([
      loadPoHub({ dash: dashboardData, rules: analyticsRules, extras: analyticsExtras }),
      loadProductHub({ dash: dashboardData, rules: analyticsRules, extras: analyticsExtras }),
      loadVendorHub(180, { dash: dashboardData }),
    ]);
    poHub = ph.status === 'fulfilled' ? ph.value : null;
    productHub = prh.status === 'fulfilled' ? prh.value : null;
    vendorHub = vh.status === 'fulfilled' ? vh.value : null;
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
