import { redirect } from 'next/navigation';
import { FormLayout, Notice } from '@/components/forms/form-layout';
import { currentUser, loadPoDetails, NotConfiguredError } from '@/lib/forms/queries';
import { PoDetailsClient } from './po-details-client';

export const dynamic = 'force-dynamic';

export default async function PoDetailsPage() {
  let user;
  try {
    user = await currentUser();
  } catch (error) {
    if (error instanceof NotConfiguredError) {
      return (
        <FormLayout title="PO Details (Form)" active="/po-details" role="viewer">
          <Notice tone="error">{error.message}</Notice>
        </FormLayout>
      );
    }
    throw error;
  }

  if (!user) redirect('/login');

  const rows = await loadPoDetails();

  return (
    <FormLayout
      title="PO Details (Form)"
      subtitle="PO issuance metadata from the Google Form — signed docs, TNA links, critical-stage dates. GCP/EasyEcom stay the source of truth for the PO itself."
      active="/po-details"
      role={user.role}
      userEmail={user.email}
      allowedPages={user.allowed_pages ?? null}
    >
      <PoDetailsClient rows={rows} />
    </FormLayout>
  );
}
