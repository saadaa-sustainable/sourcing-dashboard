import { redirect } from 'next/navigation';
import { FormLayout, Notice } from '@/components/forms/form-layout';
import {
  currentUser,
  loadAnalyticsRules,
  loadOosMeta,
  loadReplenishment,
  NotConfiguredError,
} from '@/lib/forms/queries';
import { ReplenishmentClient } from './replenishment-client';
import { loadProductLaunchDates } from '@/lib/product-launch.server';

export const dynamic = 'force-dynamic';

export default async function ReplenishmentPage() {
  let user;
  try {
    user = await currentUser();
  } catch (error) {
    if (error instanceof NotConfiguredError) {
      return (
        <FormLayout title="Replenishment" active="/replenishment" role="viewer">
          <Notice tone="error">{error.message}</Notice>
        </FormLayout>
      );
    }
    throw error;
  }

  if (!user) redirect('/login');
  if (user.role !== 'admin') redirect('/');

  const [rows, rules, meta, launchByCode] = await Promise.all([
    loadReplenishment(),
    loadAnalyticsRules(),
    loadOosMeta(),
    loadProductLaunchDates(),
  ]);

  return (
    <FormLayout
      title="Replenishment (DOQ / ROP)"
      subtitle="Reorder quantities per colour for 30 / 60 / 90-day coverage, driven by IPDOQ — the driver for the Buying Plan's pending quantity."
      active="/replenishment"
      role={user.role}
      userEmail={user.email}
      allowedPages={user.allowed_pages ?? null}
    >
      <ReplenishmentClient
        rows={rows}
        launchByCode={launchByCode}
        isAdmin={user.role === 'admin'}
        oosThreshold={rules.oos_day_threshold ?? 30}
        ipdoqFloor={rules.ipdoq_floor ?? 0.25}
        classRules={{
          aAbove: rules.product_class_a_above ?? 10,
          bMin: rules.product_class_b_min ?? 7,
          cMin: rules.product_class_c_min ?? 3,
        }}
        dataAsOf={meta.dataAsOf}
        lastSynced={meta.lastSynced}
      />
    </FormLayout>
  );
}
