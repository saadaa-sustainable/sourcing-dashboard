import { redirect } from 'next/navigation';
import { FormLayout, Notice } from '@/components/forms/form-layout';
import { currentUser, loadUsers, NotConfiguredError } from '@/lib/forms/queries';
import { hasSupabaseAdminEnv } from '@/lib/supabase/admin';
import { UsersClient } from './users-client';

export const dynamic = 'force-dynamic';

export default async function UsersPage() {
  let user;
  try {
    user = await currentUser();
  } catch (error) {
    if (error instanceof NotConfiguredError) {
      return (
        <FormLayout title="User Panel" active="/users" role="viewer">
          <Notice tone="error">{error.message}</Notice>
        </FormLayout>
      );
    }
    throw error;
  }

  if (!user) redirect('/login');

  const isAdmin = user.role === 'admin';
  const users = isAdmin ? await loadUsers() : [];

  return (
    <FormLayout
      title="User Panel"
      subtitle="Assign roles. Admins get full access; team members fill forms and approve routine items."
      active="/users"
      role={user.role}
      userEmail={user.email}
    >
      {isAdmin ? (
        <UsersClient
          users={users}
          currentEmail={user.email}
          canCreateLogins={hasSupabaseAdminEnv()}
        />
      ) : (
        <Notice tone="warn">
          Only an admin (the role manager) can manage users. You are signed in as{' '}
          {user.email} with read-only access.
        </Notice>
      )}
    </FormLayout>
  );
}
