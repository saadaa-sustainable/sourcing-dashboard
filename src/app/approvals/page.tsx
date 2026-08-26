import { redirect } from 'next/navigation';
import { FormLayout, Notice } from '@/components/forms/form-layout';
import {
  currentUser,
  loadApprovalQueue,
  loadApprovalStats,
  NotConfiguredError,
} from '@/lib/forms/queries';
import { ApprovalsClient } from './approvals-client';

export const dynamic = 'force-dynamic';

export default async function ApprovalsPage() {
  let user;
  try {
    user = await currentUser();
  } catch (error) {
    if (error instanceof NotConfiguredError) {
      return (
        <FormLayout title="Approvals" active="/approvals" role="viewer">
          <Notice tone="error">{error.message}</Notice>
        </FormLayout>
      );
    }
    throw error;
  }

  if (!user) redirect('/login');
  if (user.role !== 'admin') redirect('/');

  const [{ items, log }, stats] = await Promise.all([
    loadApprovalQueue(),
    loadApprovalStats(),
  ]);

  return (
    <FormLayout
      title="Approvals"
      subtitle="Buying plans and discontinue requests waiting on a decision."
      active="/approvals"
      role={user.role}
      userEmail={user.email}
    >
      <ApprovalsClient items={items} log={log} role={user.role} stats={stats} />
    </FormLayout>
  );
}
