import { redirect } from 'next/navigation';
import { FormLayout, Notice } from '@/components/forms/form-layout';
import { currentUser, NotConfiguredError } from '@/lib/forms/queries';
import { canView } from '@/lib/views';
import { loadSourcingPos } from '@/lib/sourcing';
import { SourcingClient } from './sourcing-client';

export const dynamic = 'force-dynamic';

export default async function SourcingPage() {
  let user;
  try {
    user = await currentUser();
  } catch (error) {
    if (error instanceof NotConfiguredError) {
      return (
        <FormLayout title="Sourcing Dashboard" active="/sourcing" role="viewer">
          <Notice tone="error">{error.message}</Notice>
        </FormLayout>
      );
    }
    throw error;
  }

  if (!user) redirect('/login');
  if (!canView('/sourcing', user.role, user.allowed_pages ?? null)) redirect('/');

  const { rows, warnings } = await loadSourcingPos();

  return (
    <FormLayout
      title="Sourcing Dashboard"
      subtitle="The sourcing view of the open PO book — every open PO with its vendor, merchandiser, quantity, TNA stage and delivery date."
      active="/sourcing"
      role={user.role}
      userEmail={user.email}
      allowedPages={user.allowed_pages ?? null}
    >
      {warnings.map((w) => (
        <Notice tone="warn" key={w}>
          {w}
        </Notice>
      ))}
      <SourcingClient rows={rows} />
    </FormLayout>
  );
}
