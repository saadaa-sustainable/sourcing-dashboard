import { redirect } from 'next/navigation';
import { FormLayout, Notice } from '@/components/forms/form-layout';
import { currentUser, NotConfiguredError } from '@/lib/forms/queries';
import { loadCostAnalytics } from '@/lib/cost-analytics.server';
import { CostAnalyticsClient } from './cost-analytics-client';

export const dynamic = 'force-dynamic';

export default async function CostAnalyticsPage() {
  let user;
  try {
    user = await currentUser();
  } catch (error) {
    if (error instanceof NotConfiguredError) {
      return (
        <FormLayout title="Cost Analytics" active="/cost-analytics" role="viewer">
          <Notice tone="error">{error.message}</Notice>
        </FormLayout>
      );
    }
    throw error;
  }

  if (!user) redirect('/login');

  const rows = await loadCostAnalytics();

  return (
    <FormLayout
      title="Cost Analytics"
      subtitle="Standard cost vs actual PO cost — sliced by vendor, product or category, drillable to PO level. A separate EFOB lens covers EFOB volume, EFOB-vs-FOB, and EFOB overpay/underpay."
      active="/cost-analytics"
      role={user.role}
      userEmail={user.email}
      allowedPages={user.allowed_pages ?? null}
      accent="purple"
    >
      <CostAnalyticsClient rows={rows} />
    </FormLayout>
  );
}
