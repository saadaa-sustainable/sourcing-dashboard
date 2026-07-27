import { redirect } from 'next/navigation';
import { FormLayout, Notice } from '@/components/forms/form-layout';
import {
  currentUser,
  loadInwardPlan,
  NotConfiguredError,
} from '@/lib/forms/queries';
import { InwardPlanClient } from './inward-plan-client';

export const dynamic = 'force-dynamic';

export default async function InwardPlanPage() {
  let user;
  try {
    user = await currentUser();
  } catch (error) {
    if (error instanceof NotConfiguredError) {
      return (
        <FormLayout title="Inward Plan" active="/inward-plan" role="viewer">
          <Notice tone="error">{error.message}</Notice>
        </FormLayout>
      );
    }
    throw error;
  }

  if (!user) redirect('/login');

  const groups = await loadInwardPlan();

  return (
    <FormLayout
      title="Inward Plan"
      subtitle="Colour-level stock still to arrive from open (Approved) POs — soonest first."
      active="/inward-plan"
      role={user.role}
      userEmail={user.email}
    >
      <InwardPlanClient groups={groups} />
    </FormLayout>
  );
}
