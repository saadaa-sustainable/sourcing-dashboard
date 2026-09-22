import { redirect } from 'next/navigation';
import { FormLayout, Notice } from '@/components/forms/form-layout';
import { currentUser, loadUsers, NotConfiguredError } from '@/lib/forms/queries';
import { loadIssueRoutes, loadIssues, syncAutoIssues } from '@/lib/issues.server';
import { IssuesClient } from './issues-client';

export const dynamic = 'force-dynamic';

export default async function IssuesPage() {
  let user;
  try {
    user = await currentUser();
  } catch (error) {
    if (error instanceof NotConfiguredError) {
      return (
        <FormLayout title="Issue Tracker" active="/issues" role="viewer">
          <Notice tone="error">{error.message}</Notice>
        </FormLayout>
      );
    }
    throw error;
  }
  if (!user) redirect('/login');

  // Opening the tracker is the natural moment to let the dashboard raise its own issues
  // and close the ones that have gone away. Best-effort; the list loads either way.
  await syncAutoIssues();

  const [issues, routes, users] = await Promise.all([loadIssues(), loadIssueRoutes(), loadUsers()]);
  const people = users
    .filter((u) => u.is_active)
    .map((u) => ({ email: u.email, name: u.full_name ?? u.email }))
    .sort((a, b) => a.name.localeCompare(b.name));

  return (
    <FormLayout
      title="Issue Tracker"
      subtitle="Raise an issue to anyone — a wrong PO, a missing timeline, a vendor problem. The dashboard raises its own from its checks. Days from raise to resolve are tracked."
      active="/issues"
      role={user.role}
      userEmail={user.email}
      allowedPages={user.allowed_pages ?? null}
    >
      <IssuesClient
        issues={issues}
        routes={routes}
        people={people}
        email={user.email}
        isAdmin={user.role === 'admin'}
        canAct={user.role !== 'viewer'}
      />
    </FormLayout>
  );
}
