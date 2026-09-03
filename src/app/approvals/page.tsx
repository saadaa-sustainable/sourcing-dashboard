import { redirect } from 'next/navigation';
import { FormLayout, Notice } from '@/components/forms/form-layout';
import {
  currentUser,
  loadApprovalQueue,
  loadApprovalStats,
  NotConfiguredError,
} from '@/lib/forms/queries';
import { loadApprovalContext } from '@/lib/approval-context.server';
import { productCodeFromLineLabel } from '@/lib/approval-context';
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

  // Item 1: inline approval context for FG buying-plan lines. Material lines
  // (raw/dyed/trims) have no garment stock/DOQ, so they're excluded.
  const fgCodes = items
    .filter((i) => i.entityType === 'buying_plan' && i.track !== 'material')
    .flatMap((i) => (i.lines ?? []).map((l) => productCodeFromLineLabel(l.label)));
  const context = await loadApprovalContext(fgCodes);

  return (
    <FormLayout
      title="Approvals"
      subtitle="Buying plans and discontinue requests waiting on a decision."
      active="/approvals"
      role={user.role}
      userEmail={user.email}
      allowedPages={user.allowed_pages ?? null}
    >
      <ApprovalsClient items={items} log={log} role={user.role} stats={stats} context={context} />
    </FormLayout>
  );
}
