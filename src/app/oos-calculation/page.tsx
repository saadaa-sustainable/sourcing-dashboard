import { redirect } from 'next/navigation';
import { FormLayout, Notice } from '@/components/forms/form-layout';
import {
  currentUser,
  loadOosCalculation,
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

  const rows = await loadOosCalculation();

  return (
    <FormLayout
      title="OOS Calculation"
      subtitle="Per-SKU out-of-stock & DOQ view over a 45-day window — inventory days, OOS days, velocity, days-on-hand, from saadaa_inventory_planning."
      active="/oos-calculation"
      role={user.role}
      userEmail={user.email}
    >
      <OosCalculationClient rows={rows} />
    </FormLayout>
  );
}
