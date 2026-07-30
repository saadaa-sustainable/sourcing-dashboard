import { redirect } from 'next/navigation';
import { FormLayout, Notice } from '@/components/forms/form-layout';
import {
  currentUser,
  loadReceivablePlan,
  NotConfiguredError,
} from '@/lib/forms/queries';
import { canEdit } from '@/lib/forms/approval';
import { ReceivablePlanClient } from './receivable-plan-client';

export const dynamic = 'force-dynamic';

export default async function ReceivablePlanPage() {
  let user;
  try {
    user = await currentUser();
  } catch (error) {
    if (error instanceof NotConfiguredError) {
      return (
        <FormLayout title="Receivable Plan" active="/receivable-plan" role="viewer">
          <Notice tone="error">{error.message}</Notice>
        </FormLayout>
      );
    }
    throw error;
  }

  if (!user) redirect('/login');

  const rows = await loadReceivablePlan();

  return (
    <FormLayout
      title="Receivable Plan"
      subtitle="Open POs pivoted to size level, with DOQ, stock and OOS — plus this week's expected delivery."
      active="/receivable-plan"
      role={user.role}
      userEmail={user.email}
    >
      <ReceivablePlanClient rows={rows} editable={canEdit(user.role, 'draft')} />
    </FormLayout>
  );
}
