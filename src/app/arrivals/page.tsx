import { redirect } from 'next/navigation';
import { FormLayout, Notice } from '@/components/forms/form-layout';
import { currentUser, loadArrivalPlan, NotConfiguredError } from '@/lib/forms/queries';
import { ArrivalsClient } from './arrivals-client';

export const dynamic = 'force-dynamic';

// Item 5 — company-wide "what's arriving when". Read-only and visible to every
// signed-in SAADAA account (not just sourcing/finance), so supply chain,
// marketing and everyone else can see the incoming goods without asking.
export default async function ArrivalsPage() {
  let user;
  try {
    user = await currentUser();
  } catch (error) {
    if (error instanceof NotConfiguredError) {
      return (
        <FormLayout title="Arrivals" active="/arrivals" role="viewer">
          <Notice tone="error">{error.message}</Notice>
        </FormLayout>
      );
    }
    throw error;
  }

  if (!user) redirect('/login');
  if (!user.email.endsWith('@saadaa.in')) {
    redirect('/login?error=This+dashboard+is+restricted+to+SAADAA+accounts.');
  }

  const { rows } = await loadArrivalPlan();

  return (
    <FormLayout
      title="Arrivals"
      subtitle="What's arriving when — the monthly approved inward plan against what's actually confirmed, across the company. Read-only; filter by product, category, vendor or month."
      active="/arrivals"
      role={user.role}
      userEmail={user.email}
      allowedPages={user.allowed_pages ?? null}
    >
      <ArrivalsClient rows={rows} />
    </FormLayout>
  );
}
