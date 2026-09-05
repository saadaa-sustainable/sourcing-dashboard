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
  // Pending-closure panel on the Open PO Tracker (best-effort — never block the dashboard).
  let closures: PoClosureView[] = [];
  let analyticsRules = ANALYTICS_RULE_DEFAULTS;
  let analyticsExtras: AnalyticsExtras | null = null;
  if (!fixtureMode) {
    try { closures = await loadOpenClosures(); } catch { closures = []; }
    analyticsRules = await loadAnalyticsRules(); // never throws
    // Cross-tab card sections (replenishment gaps, plan realization, closure
    // SLA, cost variance, discontinued check) — each section best-effort.
    try {
      analyticsExtras = await loadAnalyticsExtras(
        dashboardData.pendingPos.map((p) => ({
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
    />
  );
}
