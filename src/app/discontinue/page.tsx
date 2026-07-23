import { redirect } from 'next/navigation';
import { FormLayout, Notice } from '@/components/forms/form-layout';
import {
  currentUser,
  loadDiscontinueRequests,
  NotConfiguredError,
} from '@/lib/forms/queries';
import { DiscontinueClient } from './discontinue-client';

export const dynamic = 'force-dynamic';

export default async function DiscontinuePage() {
  let user;
  try {
    user = await currentUser();
  } catch (error) {
    if (error instanceof NotConfiguredError) {
      return (
        <FormLayout title="Discontinue" active="/discontinue" role="viewer">
          <Notice tone="error">{error.message}</Notice>
        </FormLayout>
      );
    }
    throw error;
  }

  if (!user) redirect('/login');

  const { requests, variants } = await loadDiscontinueRequests();

  return (
    <FormLayout
      title="Discontinue"
      subtitle="Variant-level discontinue approval. Auditorial process — no PO is issued."
      active="/discontinue"
      role={user.role}
    >
      <DiscontinueClient requests={requests} variants={variants} role={user.role} />
    </FormLayout>
  );
}
