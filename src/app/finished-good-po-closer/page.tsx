import { redirect } from 'next/navigation';
import { FormLayout } from '@/components/forms/form-layout';
import { currentUser } from '@/lib/forms/queries';
import { FinishedGoodPoCloserClient } from './finished-good-po-closer-client';

export const dynamic = 'force-dynamic';

export default async function FinishedGoodPoCloserPage() {
  const user = await currentUser();

  if (!user) redirect('/login');

  return (
    <FormLayout
      title="Finished Good PO Closer"
      subtitle="Finished Good purchase order closure workflow."
      active="/finished-good-po-closer"
      role={user.role}
      userEmail={user.email}
      allowedPages={user.allowed_pages ?? null}
      accent="teal"
    >
      <FinishedGoodPoCloserClient userEmail={user.email} />
    </FormLayout>
  );
}
