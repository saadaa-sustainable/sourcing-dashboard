import { redirect } from 'next/navigation';
import { FormLayout, Notice } from '@/components/forms/form-layout';
import { currentUser, loadVendorDeboarding, NotConfiguredError } from '@/lib/forms/queries';
import { VendorDeboardingClient } from './vendor-deboarding-client';

export const dynamic = 'force-dynamic';

export default async function VendorDeboardingPage() {
  let user;
  try {
    user = await currentUser();
  } catch (error) {
    if (error instanceof NotConfiguredError) {
      return (
        <FormLayout title="Vendor De-Boarding" active="/vendor-deboarding" role="viewer">
          <Notice tone="error">{error.message}</Notice>
        </FormLayout>
      );
    }
    throw error;
  }

  if (!user) redirect('/login');

  const { requests, vendors } = await loadVendorDeboarding();

  return (
    <FormLayout
      title="Vendor De-Boarding"
      subtitle="Raise a request to de-list a vendor, with the evidence behind it. Every request needs admin approval."
      active="/vendor-deboarding"
      role={user.role}
      userEmail={user.email}
      allowedPages={user.allowed_pages ?? null}
    >
      <VendorDeboardingClient requests={requests} vendors={vendors} role={user.role} />
    </FormLayout>
  );
}
