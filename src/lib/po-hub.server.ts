import { loadDashboardData } from '@/lib/data';
import { buildTrackerRows } from '@/lib/business-logic';
import { loadAnalyticsExtras, loadAnalyticsRules } from '@/lib/forms/queries';
import type { InternalStatus } from '@/lib/types';

/**
 * PO objective one-pager (DAM principle: one base dimension = PO, full picture around
 * it). Consolidates the PO-anchored facets that today live as separate Main-Dashboard
 * cards — financial risk (Capital at Risk + Cost Variance), timeline compliance (TNA),
 * closure compliance, and flow (issued this week + pending approval) — into one view
 * with a per-PO exception table. Assembled by REUSING existing loaders
 * (buildTrackerRows + loadAnalyticsExtras); no recomputation, source cards untouched.
 */
export type PoHubRow = {
  poRef: string;
  productCode: string;
  vendorName: string;
  vendorCode: string;
  poType: string;
  pendingQty: number;
  pendingValue: number;
  edd: string | null;
  delayDays: number;
  stage: string;
  status: InternalStatus;
  costVarianceDelta: number | null; // ₹ TOTAL above standard (rate gap × qty) — only the top-3 flagged POs this month carry it
};

export type PoHubData = {
  summary: {
    openPos: number;
    openValue: number;
    atRiskValue: number;
    atRiskCount: number;
    onTrack: number;
    highRisk: number;
    overdue: number;
    tnaOnTimePct: number;
    costVarianceCount: number;
    costVarianceImpact: number;
    closureWithinSlaPct: number | null;
    closureSlaDays: number | null;
    issuedThisWeek: number;
    issuedDeltaPct: number | null;
    pendingApprovalCount: number;
  };
  rows: PoHubRow[];
};

export async function loadPoHub(): Promise<PoHubData> {
  const [dash, rules] = await Promise.all([loadDashboardData(), loadAnalyticsRules()]);
  const tracker = buildTrackerRows(
    dash.pendingPos,
    dash.vendorTypes,
    dash.vendorMasters,
    dash.tnaRecords,
  );

  // Reuse the same PO-facet sources as the dashboard cards (cost variance, closure
  // SLA, issuance flow, pending approval). Best-effort — never blocks the page.
  let extras: Awaited<ReturnType<typeof loadAnalyticsExtras>> | null = null;
  try {
    extras = await loadAnalyticsExtras(
      dash.pendingPos.map((p) => ({
        code: (p.product_code ?? '').trim(),
        variant: (p.product_variant ?? '').trim(),
        qty: Number(p.pending_qty_actual) || 0,
      })),
      rules,
    );
  } catch {
    extras = null;
  }

  // Per-PO cost-variance flag (this month's above-standard issues), keyed by PO ref.
  const cvByRef = new Map<string, number>();
  for (const t of extras?.costVariance?.top ?? []) cvByRef.set(t.poRef, t.delta);

  const rows: PoHubRow[] = tracker.map((r) => ({
    poRef: r.poRef,
    productCode: r.productCode,
    vendorName: r.vendorName,
    vendorCode: r.vendorCode,
    poType: r.poType,
    pendingQty: r.pendingQty,
    pendingValue: r.pendingValue,
    edd: r.edd,
    delayDays: r.delayDays,
    stage: r.stage,
    status: r.internalStatus,
    costVarianceDelta: cvByRef.get(r.poRef) ?? null,
  }));

  const openValue = rows.reduce((s, r) => s + r.pendingValue, 0);
  const atRisk = rows.filter((r) => r.status !== 'On Track');
  // Counts are per PO (distinct reference), not per tracker line (PO × product ×
  // EDD) — matches the Dashboard's "Open POs". A PO is at risk if ANY of its
  // lines is; on track only when all lines are.
  const poRefs = new Set(rows.map((r) => r.poRef));
  const riskByPo = new Map<string, 'On Track' | 'High Risk' | 'Overdue'>();
  for (const r of rows) {
    const cur = riskByPo.get(r.poRef);
    const rank = (s: string) => (s === 'Overdue' ? 2 : s === 'High Risk' ? 1 : 0);
    if (!cur || rank(r.status) > rank(cur)) riskByPo.set(r.poRef, r.status as 'On Track' | 'High Risk' | 'Overdue');
  }
  const onTrack = [...riskByPo.values()].filter((s) => s === 'On Track').length;
  const highRisk = [...riskByPo.values()].filter((s) => s === 'High Risk').length;
  const overdue = [...riskByPo.values()].filter((s) => s === 'Overdue').length;
  const closure = extras?.closure ?? null;
  const issued = extras?.issuedLastWeek ?? null;

  return {
    summary: {
      openPos: poRefs.size,
      openValue,
      atRiskValue: atRisk.reduce((s, r) => s + r.pendingValue, 0),
      atRiskCount: new Set(atRisk.map((r) => r.poRef)).size,
      onTrack,
      highRisk,
      overdue,
      tnaOnTimePct: poRefs.size ? Math.round((onTrack / poRefs.size) * 100) : 0,
      costVarianceCount: extras?.costVariance?.count ?? 0,
      costVarianceImpact: extras?.costVariance?.impact ?? 0,
      closureWithinSlaPct:
        closure && closure.closedTotal > 0
          ? Math.round((closure.closedWithinSla / closure.closedTotal) * 100)
          : null,
      closureSlaDays: closure?.slaDays ?? null,
      issuedThisWeek: issued?.count ?? 0,
      issuedDeltaPct: issued?.delta?.countPct ?? null,
      pendingApprovalCount: extras?.pendingApproval?.count ?? 0,
    },
    rows: rows.sort((a, b) => b.pendingValue - a.pendingValue),
  };
}
