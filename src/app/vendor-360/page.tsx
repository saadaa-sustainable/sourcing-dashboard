import { redirect } from 'next/navigation';
import { FormLayout, Notice } from '@/components/forms/form-layout';
import { currentUser, NotConfiguredError } from '@/lib/forms/queries';
import { loadVendorHub } from '@/lib/vendor-hub.server';
import { Vendor360Client } from './vendor-360-client';

export const dynamic = 'force-dynamic';

export default async function Vendor360Page() {
  let user;
  try {
    user = await currentUser();
  } catch (error) {
    if (error instanceof NotConfiguredError) {
      return (
        <FormLayout title="Vendor 360" active="/vendor-360" role="viewer">
          <Notice tone="error">{error.message}</Notice>
        </FormLayout>
      );
    }
    throw error;
  }

  if (!user) redirect('/login');

  const data = await loadVendorHub();

  return (
    <FormLayout
      title="Vendor 360"
      subtitle="One objective, one dimension — every vendor's concentration, delivery reliability, capacity and OTIF scoring in a single one-pager (the DAM principle), instead of piecing it together across separate cards."
      active="/vendor-360"
      role={user.role}
      userEmail={user.email}
      allowedPages={user.allowed_pages ?? null}
      accent="blue"
    >
      <Vendor360Client data={data} />
    </FormLayout>
  );
}
