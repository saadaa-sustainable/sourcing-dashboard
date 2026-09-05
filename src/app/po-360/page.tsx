import { redirect } from 'next/navigation';
import { FormLayout, Notice } from '@/components/forms/form-layout';
import { currentUser, NotConfiguredError } from '@/lib/forms/queries';
import { loadPoHub } from '@/lib/po-hub.server';
import { Po360Client } from './po-360-client';

export const dynamic = 'force-dynamic';

export default async function Po360Page() {
  let user;
  try {
    user = await currentUser();
  } catch (error) {
    if (error instanceof NotConfiguredError) {
      return (
        <FormLayout title="PO Overview" active="/po-360" role="viewer">
          <Notice tone="error">{error.message}</Notice>
        </FormLayout>
      );
    }
    throw error;
  }

  if (!user) redirect('/login');

  const data = await loadPoHub();

  return (
    <FormLayout
      title="PO Overview"
      subtitle="One objective, one dimension — every open PO's financial risk, timeline compliance, closure and issuance flow in a single one-pager (the DAM principle), instead of piecing it together across separate cards."
      active="/po-360"
      role={user.role}
      userEmail={user.email}
      allowedPages={user.allowed_pages ?? null}
      accent="orange"
    >
      <Po360Client data={data} />
    </FormLayout>
  );
}
