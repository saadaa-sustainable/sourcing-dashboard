import { redirect } from 'next/navigation';
import { FormLayout, Notice } from '@/components/forms/form-layout';
import {
  currentUser,
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

  const rows = await loadReplenishment();

  return (
    <FormLayout
      title="Replenishment (DOQ / ROP)"
      subtitle="Reorder quantities per colour for 30 / 60 / 90-day coverage — the driver for the Buying Plan's pending quantity."
      active="/replenishment"
      role={user.role}
      userEmail={user.email}
    >
      <ReplenishmentClient rows={rows} />
    </FormLayout>
  );
}
