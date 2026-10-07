import { skuKey } from '@/lib/sku-key';
import type { DoqPartialDay, OosCalculationRow } from '@/lib/forms/types';
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
import type { IncludedSku } from './included-sku-panel';
import { packRows } from '@/lib/packed-rows';

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
  // Keyed the feed's way (no underscore) — see skuKey.
  const excluded = new Set(exclusions.map((e) => skuKey(e.sku)));

  // The SKU universe is the team's OOS SKU list: the EasyEcom product master minus the exclusion
  // list (reconciled with the DOQ sheet 2026-10-07 — the feed alone lacks ~400 of its SKUs, mostly
  // NPD not launched yet). A SKU the feed does not carry counts with no stock and no sales: never
  // out of stock, DOQ 0 — exactly how the sheet treats a SKU with no inventory row.
  // Same selling-price rule as OOS Calculation: Shopify SP, else product-master MRP — so Sales
  // Leakage reconciles between the two pages. Product STATE comes from the EasyEcom product
  // master first, the feed's own state as fallback.
  const oosByKey = new Map(oosRaw.map((m) => [skuKey(m.sku), m]));
  const oosMeta = Object.entries(pm)
    .filter(([k]) => !excluded.has(k))
    .map(([k, p]) => {
      const m: OosCalculationRow = oosByKey.get(k) ?? {
        sku: k,
        product_status: null,
        category_with_gender: null,
        rm_code: null,
        dyed_fabric_sku: null,
        product_variant: p.variant,
        product_code: p.variant && p.variant.length > 2 ? p.variant.slice(0, -2) : p.variant,
        product_name: p.name,
        color: p.colour,
        size: p.size,
        total_inventory_days: null,
        total_oos_days: 0,
        total_available_days: null,
        total_qty_sold: 0,
        doq_45: 0,
        launch_date: p.launch,
        product_class: null,
        current_stock: 0,
        doh: null,
        sales_value: null,
        sales_leakage: null,
        inprocess_stock: 0,
        doh_with_inprocess: null,
        cancelled: null,
        returned: null,
        com_status: null,
        weave_type: p.weave,
      };
      return {
        ...m,
        weave_type: m.weave_type ?? p.weave,
        sales_value: m.sales_value ?? p.mrp ?? null,
        product_status: normaliseProductState(p.state) ?? normaliseProductState(m.product_status),
      };
    });
  const priceFactor = rules.leakage_price_factor ?? 0.85;

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
  // Last 45 days = the DOQ sheet's 45-day table: each SKU's own 45-day figures (OOS days = the
  // feed's oos_days_45, available = 45 − OOS, qty = 45-day qty sold), not a day-by-day count —
  // the feed's per-day stock is today's stock repeated, so it cannot see past stock-outs.
  for (const m of oosMeta) {
    const w = (windows[m.sku] ??= { sku: m.sku } as (typeof windows)[string]);
    w.f45_qty = Number(m.total_qty_sold) || 0;
    w.f45_avail = Number(m.total_available_days) || 0;
    w.f45_oos = Number(m.total_oos_days) || 0;
  }
  for (const key of DOQ_WINDOW_KEYS) {
    tables[key] = {} as Record<DoqWeave, DoqCategoryRow[]>;
    comTables[key] = {} as Record<DoqWeave, DoqCategoryRow[]>;
    const ndays = key === 'f45' ? 45 : meta?.windows?.[key]?.ndays ?? 1;
    const totalDoh = key === 'f45' ? ('rows' as const) : ('skus' as const);
    for (const weave of DOQ_WEAVES) {
      tables[key][weave] = aggregateDoqWindow(windows, oosMeta, excluded, key, weave, ndays, { priceFactor, totalDoh });
      comTables[key][weave] = aggregateDoqWindow(windows, oosMeta, excluded, key, weave, ndays, {
        categoryOf: (m) => comStatusOf(m.product_status, classBySku[m.sku] ?? 'D'),
        order: 'com',
        priceFactor,
        totalDoh,
      });
    }
  }

  // The SKUs every table above counts: the feed minus the exclusion list (same filter as
  // aggregateDoqWindow), listed for the Included SKUs panel. Packed — ~4,000 rows.
  const included = packRows<IncludedSku>(
    oosMeta
      .filter((m) => !excluded.has(skuKey(m.sku)))
      .map((m) => {
        const cls = classBySku[m.sku] ?? 'D';
        return {
          sku: m.sku,
          product_code: m.product_code,
          product_name: m.product_name,
          color: m.color,
          size: m.size,
          weave: m.weave_type?.trim() || 'Unknown',
          product_status: m.product_status?.trim() || 'Unknown',
          product_class: cls,
          com_status: comStatusOf(m.product_status, cls),
          current_stock: m.current_stock,
          inprocess_stock: m.inprocess_stock,
          doq_45: m.doq_45,
          oos_days_45: m.total_oos_days,
        };
      })
      .sort((a, b) => a.sku.localeCompare(b.sku)),
  );

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
        included={included}
        editable={user.role !== 'viewer'}
        summary={summary}
        snapshots={snapshots}
        initialView={params.view === 'detail' ? 'detail' : 'summary'}
        partialDay={partialDay}
      />
    </FormLayout>
  );
}
