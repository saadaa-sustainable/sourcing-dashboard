import { redirect } from 'next/navigation';
import { FormLayout, Notice } from '@/components/forms/form-layout';
import {
  currentUser,
  loadReceivablePlan,
  NotConfiguredError,
} from '@/lib/forms/queries';
import { canEdit, weekStart } from '@/lib/forms/approval';
import { ReceivablePlanClient } from './receivable-plan-client';

// The current receiving week (Mon–Sun), computed server-side so the client's
// "arriving this week" filter needs no clock of its own.
function weekRange() {
  const start = weekStart();
  const end = new Date(`${start}T00:00:00Z`);
  end.setUTCDate(end.getUTCDate() + 6);
  return { weekStart: start, weekEnd: end.toISOString().slice(0, 10) };
}

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
  const week = weekRange();

  return (
    <FormLayout
      title="Receivable Plan"
      subtitle="Open POs pivoted to size level, with DOQ, stock and OOS — plus this week's expected delivery."
      active="/receivable-plan"
      role={user.role}
      userEmail={user.email}
      allowedPages={user.allowed_pages ?? null}
    >
      <ReceivablePlanClient
        rows={rows}
        editable={canEdit(user.role, 'draft')}
        weekStart={week.weekStart}
        weekEnd={week.weekEnd}
      />
    </FormLayout>
  );
}
