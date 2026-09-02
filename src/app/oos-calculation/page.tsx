import { redirect } from 'next/navigation';
import { FormLayout, Notice } from '@/components/forms/form-layout';
import {
  currentUser,
  loadAnalyticsRules,
  loadOosCalculation,
  loadOosExclusions,
  loadOosMeta,
  loadPmLaunchPrice,
  loadSkuClassInputs,
  NotConfiguredError,
} from '@/lib/forms/queries';
import { computeSkuIpdoq, isNpdFamily, productClassOf } from '@/lib/doq-dashboard';
import { OosCalculationClient } from './oos-calculation-client';

export const dynamic = 'force-dynamic';

export default async function OosCalculationPage() {
  let user;
  try {
    user = await currentUser();
  } catch (error) {
    if (error instanceof NotConfiguredError) {
      return (
        <FormLayout title="OOS Calculation" active="/oos-calculation" role="viewer">
          <Notice tone="error">{error.message}</Notice>
        </FormLayout>
      );
    }
    throw error;
  }

  if (!user) redirect('/login');

  const [rawRows, exclusions, meta, pm, classInputs, rules] = await Promise.all([
    loadOosCalculation(),
    loadOosExclusions(),
    loadOosMeta(),
    loadPmLaunchPrice(),
    loadSkuClassInputs(),
    loadAnalyticsRules(),
  ]);

  const classRules = {
    aAbove: rules.product_class_a_above ?? 10,
    bMin: rules.product_class_b_min ?? 7,
    cMin: rules.product_class_c_min ?? 3,
  };

  // Fallbacks from the product master (spec items 2-3): launch date, and MRP as
  // the last-resort Selling Price for SKUs with no Shopify SP in the pipeline.
  // Product Class computed live from IPDOQ (NPD-family SKUs are not classed).
  const rows = rawRows.map((r) => {
    const m = pm[r.sku];
    const ci = classInputs[r.sku];
    const ipdoq = computeSkuIpdoq(
      ci?.doq45 ?? r.doq_45 ?? 0,
      ci?.doq365 ?? 0,
      ci?.oos45 ?? r.total_oos_days ?? 0,
      rules.oos_day_threshold ?? 30,
      rules.ipdoq_floor ?? 0.25,
    );
    return {
      ...r,
      launch_date: r.launch_date ?? m?.launch ?? null,
      sales_value: r.sales_value ?? m?.mrp ?? null,
      product_class: isNpdFamily(r.product_status) ? 'NPD' : productClassOf(ipdoq, classRules),
    };
  });

  return (
    <FormLayout
      title="OOS Calculation"
      subtitle="Per-SKU DOQ / out-of-stock view over a 45-day window — DOQ (velocity), available days, OOS days, days-on-hand, selling price and sales leakage."
      active="/oos-calculation"
      role={user.role}
      userEmail={user.email}
      allowedPages={user.allowed_pages ?? null}
    >
      <OosCalculationClient
        rows={rows}
        exclusions={exclusions}
        canManage={user.role !== 'viewer'}
        dataAsOf={meta.dataAsOf}
        lastSynced={meta.lastSynced}
      />
    </FormLayout>
  );
}
