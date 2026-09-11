import { redirect } from 'next/navigation';
import { FormLayout, Notice } from '@/components/forms/form-layout';
import { currentUser, loadAdoption, NotConfiguredError } from '@/lib/forms/queries';
import { AdoptionClient } from './adoption-client';

export const dynamic = 'force-dynamic';

export default async function AdoptionPage() {
  let user;
  try {
    user = await currentUser();
  } catch (error) {
    if (error instanceof NotConfiguredError) {
      return (
        <FormLayout title="Adoption & Activity" active="/adoption" role="viewer">
          <Notice tone="error">{error.message}</Notice>
        </FormLayout>
      );
    }
    throw error;
  }
  if (!user) redirect('/login');
  if (user.role !== 'admin') redirect('/');

  const data = await loadAdoption();

  return (
    <FormLayout
      title="Adoption & Activity"
      subtitle="Who is logging in, who isn't, and whether entries are being made — from last-seen and the activity log."
      active="/adoption"
      role={user.role}
      userEmail={user.email}
      allowedPages={user.allowed_pages ?? null}
      accent="blue"
    >
      <AdoptionClient data={data} />
    </FormLayout>
  );
}
