import { skuKey } from '@/lib/sku-key';
import type { DoqPartialDay } from '@/lib/forms/types';
import { redirect } from 'next/navigation';
import { FormLayout, Notice } from '@/components/forms/form-layout';
import {
  currentUser,
  loadAnalyticsRules,
  loadDoqWindowMeta,
  loadDoqWindows,
  loadOosCalculation,
  loadOosExclusions,
  loadPmLaunchPrice,
  loadOosSummary,
  loadOosSnapshots,
  recordOosSnapshot,
  loadSkuClassInputs,
  NotConfiguredError,
} from '@/lib/forms/queries';
import { canView } from '@/lib/views';
import {
  aggregateDoqWindow,
  comStatusOf,
  computeSkuIpdoq,
  DOQ_WEAVES,
  DOQ_WINDOW_KEYS,
  productClassOf,
  type DoqCategoryRow,
  type DoqWeave,
  type DoqWindowKey,
  normaliseProductState,
} from '@/lib/doq-dashboard';
import { DoqDashboardClient } from './doq-dashboard-client';

export const dynamic = 'force-dynamic';

export default async function DoqDashboardPage({ searchParams }: { searchParams: Promise<{ view?: string }> }) {
  const params = await searchParams;
  let user;
  try {
    user = await currentUser();
  } catch (error) {
    if (error instanceof NotConfiguredError) {
      return (
        <FormLayout title="OOS Dashboard" active="/doq-dashboard" role="viewer">
          <Notice tone="error">{error.message}</Notice>
        </FormLayout>
      );
    }
    throw error;
  }

  if (!user) redirect('/login');
  if (!canView('/doq-dashboard', user.role, user.allowed_pages ?? null)) redirect('/');

  const [windows, meta, oosRaw, exclusions, classInputs, rules, pm,
    summary,
    snapshots,
  ] = await Promise.all([
    loadDoqWindows(),
    loadDoqWindowMeta(),
    loadOosCalculation(),
    loadOosExclusions(),
    loadSkuClassInputs(),
    loadAnalyticsRules(),
    loadPmLaunchPrice(),
    loadOosSummary(),
    loadOosSnapshots(),
  ]);
  // Record today's position for the trend (idempotent per data day), then fold it into
  // the history the chart reads so the first day shows without a reload.
  if (summary) {
    await recordOosSnapshot(summary.asOf, [summary.all, ...summary.categories]);
    if (summary.asOf && !snapshots.some((p) => p.snapshot_date === summary.asOf)) {
      snapshots.push({
        snapshot_date: summary.asOf,
        skus: summary.all.skus,
        oos_yesterday: summary.all.oosYesterday,
        oos_45: summary.all.oos45,
        oos_days_45: summary.all.oosDays45,
        recovered_45: summary.all.recovered45,
      });
    }
  }
  // Same selling-price rule as OOS Calculation: Shopify SP, else product-master MRP —
  // so Sales Leakage reconciles between the two pages. Product STATE comes from the EasyEcom
  // product master first (the list the team maintains and the DOQ sheet reads: it knows "NPD"
  // where the feed says "NPD - Not Launched Yet" or nothing), the feed's own state as fallback.
  const oosMeta = oosRaw.map((m) => {
    const p = pm[skuKey(m.sku)];
    return {
      ...m,
      sales_value: m.sales_value ?? p?.mrp ?? null,
      product_status: normaliseProductState(p?.state) ?? normaliseProductState(m.product_status),
    };
  });

  // Keyed the feed's way (no underscore) — see skuKey.
  const excluded = new Set(exclusions.map((e) => skuKey(e.sku)));

  // Is the newest day's sales column complete? BqSync (once redeployed) anchors the windows
  // on the last complete day and says so in the meta. Until then the same check is made
  // here from the window rows: the latest day against the average of the six before it.
  let partialDay: DoqPartialDay | null = null;
  if (meta?.partial) {
    partialDay = { ...meta.partial, anchoredOn: meta.latest };
  } else if (meta) {
    let d1 = 0;
    let l7 = 0;
    for (const r of Object.values(windows)) {
      d1 += Number(r.d1_qty) || 0;
      l7 += Number(r.l7_qty) || 0;
    }
    const avgPrior = (l7 - d1) / 6;
    if (avgPrior > 0 && d1 < 0.4 * avgPrior) {
      partialDay = { date: meta.latest, qty: d1, avgPrior: Math.round(avgPrior), anchoredOn: null };
    }
  }

  // Product Class per SKU from IPDOQ (rules-master thresholds, live).
  const classRules = {
    aAbove: rules.product_class_a_above ?? 10,
    bMin: rules.product_class_b_min ?? 7,
    cMin: rules.product_class_c_min ?? 3,
  };
  const classBySku: Record<string, string> = {};
  for (const m of oosMeta) {
    const ci = classInputs[m.sku];
    // `||`: the class-input map seeds SKUs at 0, so a 0 must fall back to the OOS row.
    const ipdoq = computeSkuIpdoq(
      ci?.doq45 || m.doq_45 || 0,
      ci?.doq365 ?? 0,
      ci?.oos45 || m.total_oos_days || 0,
      rules.oos_day_threshold ?? 30,
      rules.ipdoq_floor ?? 0.25,
    );
    classBySku[m.sku] = productClassOf(ipdoq, classRules);
  }

  // Pre-aggregate every window × weave server-side; the client only switches.
  // Two breakdowns per the sheet: By Product Status + By COM Status (detail).
  const tables = {} as Record<DoqWindowKey, Record<DoqWeave, DoqCategoryRow[]>>;
  const comTables = {} as Record<DoqWindowKey, Record<DoqWeave, DoqCategoryRow[]>>;
  for (const key of DOQ_WINDOW_KEYS) {
    tables[key] = {} as Record<DoqWeave, DoqCategoryRow[]>;
    comTables[key] = {} as Record<DoqWeave, DoqCategoryRow[]>;
    const ndays = meta?.windows?.[key]?.ndays ?? 1;
    for (const weave of DOQ_WEAVES) {
      tables[key][weave] = aggregateDoqWindow(windows, oosMeta, excluded, key, weave, ndays);
      comTables[key][weave] = aggregateDoqWindow(windows, oosMeta, excluded, key, weave, ndays, {
        categoryOf: (m) => comStatusOf(m.product_status, classBySku[m.sku] ?? 'D'),
        order: 'com',
      });
    }
  }

  return (
    <FormLayout
      title="OOS Dashboard"
      subtitle="The DOQ window view — daily demand rate, days-on-hand, OOS days and sales leakage by product state, over yesterday / weekly / 7-day / all-time windows. Ported formula-for-formula from the DOQ sheet."
      active="/doq-dashboard"
      role={user.role}
      userEmail={user.email}
      allowedPages={user.allowed_pages ?? null}
    >
      {!meta && (
        <Notice tone="warn">
          Window aggregates have not been synced yet — run bqSyncDoqWindows in
          the Apps Script project (or wait for the next 6 AM sync).
        </Notice>
      )}
      <DoqDashboardClient
        tables={tables}
        comTables={comTables}
        meta={meta}
        exclusions={exclusions}
        editable={user.role !== 'viewer'}
        summary={summary}
        snapshots={snapshots}
        initialView={params.view === 'detail' ? 'detail' : 'summary'}
        partialDay={partialDay}
      />
    </FormLayout>
  );
}
