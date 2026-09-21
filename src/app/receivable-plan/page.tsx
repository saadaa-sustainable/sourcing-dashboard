import { redirect } from 'next/navigation';
import { FormLayout, Notice } from '@/components/forms/form-layout';
import {
  currentUser,
  loadArrivalPlan,
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
        <FormLayout title="Inward Plan" active="/receivable-plan" role="viewer">
          <Notice tone="error">{error.message}</Notice>
        </FormLayout>
      );
    }
    throw error;
  }

  if (!user) redirect('/login');

  // Both tabs load together: the page is one screen with two views, not two pages.
  const [rows, arrivals] = await Promise.all([loadReceivablePlan(), loadArrivalPlan()]);
  const week = weekRange();

  return (
    <FormLayout
      title="Inward Plan"
      subtitle="What is arriving and when. Arrivals shows what was expected against what actually landed; Input Inward Plan is where the team enters the quantity and week to expect."
      active="/receivable-plan"
      role={user.role}
      userEmail={user.email}
      allowedPages={user.allowed_pages ?? null}
    >
      <ReceivablePlanClient
        rows={rows}
        arrivals={arrivals.rows}
        editable={canEdit(user.role, 'draft')}
        weekStart={week.weekStart}
        weekEnd={week.weekEnd}
      />
    </FormLayout>
  );
}
