import { redirect } from 'next/navigation';
import { FormLayout, Notice } from '@/components/forms/form-layout';
import {
  currentUser,
  loadAnalyticsRules,
  loadReplenishment,
  NotConfiguredError,
} from '@/lib/forms/queries';
import { ReplenishmentClient } from './replenishment-client';

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

  const [rows, rules] = await Promise.all([loadReplenishment(), loadAnalyticsRules()]);

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
        isAdmin={user.role === 'admin'}
        oosThreshold={rules.oos_day_threshold ?? 30}
        ipdoqFloor={rules.ipdoq_floor ?? 0.25}
      />
    </FormLayout>
  );
}
