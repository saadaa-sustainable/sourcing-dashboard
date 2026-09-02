import { redirect } from 'next/navigation';
import { FormLayout, Notice } from '@/components/forms/form-layout';
import {
  currentUser,
  loadAnalyticsRules,
  loadDoqWindowMeta,
  loadDoqWindows,
  loadOosCalculation,
  loadOosExclusions,
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
} from '@/lib/doq-dashboard';
import { DoqDashboardClient } from './doq-dashboard-client';

export const dynamic = 'force-dynamic';

export default async function DoqDashboardPage() {
  let user;
  try {
    user = await currentUser();
  } catch (error) {
    if (error instanceof NotConfiguredError) {
      return (
        <FormLayout title="DOQ Dashboard" active="/doq-dashboard" role="viewer">
          <Notice tone="error">{error.message}</Notice>
        </FormLayout>
      );
    }
    throw error;
  }

  if (!user) redirect('/login');
  if (!canView('/doq-dashboard', user.role, user.allowed_pages ?? null)) redirect('/');

  const [windows, meta, oosMeta, exclusions, classInputs, rules] = await Promise.all([
    loadDoqWindows(),
    loadDoqWindowMeta(),
    loadOosCalculation(),
    loadOosExclusions(),
    loadSkuClassInputs(),
    loadAnalyticsRules(),
  ]);

  const excluded = new Set(exclusions.map((e) => e.sku.toUpperCase()));

  // Product Class per SKU from IPDOQ (rules-master thresholds, live).
  const classRules = {
    aAbove: rules.product_class_a_above ?? 10,
    bMin: rules.product_class_b_min ?? 7,
    cMin: rules.product_class_c_min ?? 3,
  };
  const classBySku: Record<string, string> = {};
  for (const m of oosMeta) {
    const ci = classInputs[m.sku];
    const ipdoq = computeSkuIpdoq(
      ci?.doq45 ?? m.doq_45 ?? 0,
      ci?.doq365 ?? 0,
      ci?.oos45 ?? m.total_oos_days ?? 0,
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
      title="DOQ Dashboard"
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
        excludedCount={excluded.size}
      />
    </FormLayout>
  );
}
