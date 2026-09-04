import { redirect } from 'next/navigation';
import { FormLayout, Notice } from '@/components/forms/form-layout';
import { currentUser, loadPpmPrep, NotConfiguredError } from '@/lib/forms/queries';
import { PpmPrepClient } from './ppm-prep-client';

export const dynamic = 'force-dynamic';

// Item 3 — PPM Prep: one view assembling everything manually compiled ahead of
// the Production Planning Meeting, pulled from each existing source.
export default async function PpmPrepPage() {
  let user;
  try {
    user = await currentUser();
  } catch (error) {
    if (error instanceof NotConfiguredError) {
      return (
        <FormLayout title="PPM Prep" active="/ppm-prep" role="viewer">
          <Notice tone="error">{error.message}</Notice>
        </FormLayout>
      );
    }
    throw error;
  }

  if (!user) redirect('/login');

  const prep = await loadPpmPrep();

  return (
    <FormLayout
      title="PPM Prep"
      subtitle="Everything compiled before the Production Planning Meeting, in one place — pulled live from each source. Each section links to its detail page."
      active="/ppm-prep"
      role={user.role}
      userEmail={user.email}
      allowedPages={user.allowed_pages ?? null}
    >
      <PpmPrepClient prep={prep} />
    </FormLayout>
  );
}
