import { redirect } from 'next/navigation';
import { FormLayout, Notice } from '@/components/forms/form-layout';
import {
  currentUser,
  loadSyncStatus,
  NotConfiguredError,
} from '@/lib/forms/queries';
import { SyncStatusClient } from './sync-status-client';

export const dynamic = 'force-dynamic';

export default async function SyncStatusPage() {
  let user;
  try {
    user = await currentUser();
  } catch (error) {
    if (error instanceof NotConfiguredError) {
      return (
        <FormLayout title="Sync Health" active="/sync-status" role="viewer">
          <Notice tone="error">{error.message}</Notice>
        </FormLayout>
      );
    }
    throw error;
  }

  if (!user) redirect('/login');

  const rows = await loadSyncStatus();

  return (
    <FormLayout
      title="Sync Health"
      subtitle="Is the data fresh? Each source, its pipeline, row count and when it last refreshed — so a silently-failed sync doesn't go unnoticed."
      active="/sync-status"
      role={user.role}
      userEmail={user.email}
      allowedPages={user.allowed_pages ?? null}
    >
      <SyncStatusClient rows={rows} />
    </FormLayout>
  );
}
