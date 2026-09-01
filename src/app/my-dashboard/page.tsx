import { redirect } from 'next/navigation';
import { FormLayout, Notice } from '@/components/forms/form-layout';
import { currentUser, NotConfiguredError } from '@/lib/forms/queries';
import { canView } from '@/lib/views';
import { loadSourcingPos } from '@/lib/sourcing';
import { MyDashboardClient, type RoleViewId } from './my-dashboard-client';

export const dynamic = 'force-dynamic';

// The role-view registry for My Dashboard. Each view is granted through the
// pseudo-path my:<id> in the views registry — a user sees the views their
// custom roles grant; admins and unrestricted users see them all (as tabs).
const ROLE_VIEWS: { id: RoleViewId; label: string; path: string }[] = [
  { id: 'sourcing', label: 'Sourcing', path: 'my:sourcing' },
];

export default async function MyDashboardPage() {
  let user;
  try {
    user = await currentUser();
  } catch (error) {
    if (error instanceof NotConfiguredError) {
      return (
        <FormLayout title="My Dashboard" active="/my-dashboard" role="viewer">
          <Notice tone="error">{error.message}</Notice>
        </FormLayout>
      );
    }
    throw error;
  }

  if (!user) redirect('/login');

  const views = ROLE_VIEWS.filter((v) =>
    canView(v.path, user.role, user.allowed_pages ?? null),
  );
  const needSourcing = views.some((v) => v.id === 'sourcing');
  const sourcing = needSourcing
    ? await loadSourcingPos()
    : { rows: [], warnings: [] };

  return (
    <FormLayout
      title="My Dashboard"
      subtitle="Your role-specific view of the sourcing operation. Admins can scroll through every role's view."
      active="/my-dashboard"
      role={user.role}
      userEmail={user.email}
      allowedPages={user.allowed_pages ?? null}
    >
      {sourcing.warnings.map((w) => (
        <Notice tone="warn" key={w}>
          {w}
        </Notice>
      ))}
      <MyDashboardClient
        views={views.map(({ id, label }) => ({ id, label }))}
        sourcingRows={sourcing.rows}
      />
    </FormLayout>
  );
}
