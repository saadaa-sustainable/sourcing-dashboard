import { redirect } from 'next/navigation';
import { FormLayout, Notice } from '@/components/forms/form-layout';
import {
  currentUser,
  loadOosCalculation,
  loadOosExclusions,
  loadOosMeta,
  loadPmLaunchPrice,
  NotConfiguredError,
} from '@/lib/forms/queries';
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

  const [rawRows, exclusions, meta, pm] = await Promise.all([
    loadOosCalculation(),
    loadOosExclusions(),
    loadOosMeta(),
    loadPmLaunchPrice(),
  ]);

  // Fallbacks from the product master (spec items 2-3): launch date, and MRP as
  // the last-resort Selling Price for SKUs with no Shopify SP in the pipeline.
  const rows = rawRows.map((r) => {
    const m = pm[r.sku];
    return {
      ...r,
      launch_date: r.launch_date ?? m?.launch ?? null,
      sales_value: r.sales_value ?? m?.mrp ?? null,
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
