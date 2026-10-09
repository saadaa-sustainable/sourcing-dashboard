import { redirect } from 'next/navigation';
import { FormLayout, Notice } from '@/components/forms/form-layout';
import { currentUser, loadVendorCommercial, NotConfiguredError } from '@/lib/forms/queries';
import { VendorCommercialClient } from './vendor-commercial-client';

export const dynamic = 'force-dynamic';

export default async function VendorCommercialPage() {
  let user;
  try {
    user = await currentUser();
  } catch (error) {
    if (error instanceof NotConfiguredError) {
      return (
        <FormLayout title="Vendor Commercial Approval" active="/vendor-commercial" role="viewer">
          <Notice tone="error">{error.message}</Notice>
        </FormLayout>
      );
    }
    throw error;
  }
  if (!user) redirect('/login');

  const { ready, requests, vendors } = await loadVendorCommercial();

  return (
    <FormLayout
      title="Vendor Commercial Approval"
      subtitle="Raise a commercial request for a vendor — hold waiver, cost increment, cash discount, DN removal or credit note. Every request needs admin approval."
      active="/vendor-commercial"
      role={user.role}
      userEmail={user.email}
      allowedPages={user.allowed_pages ?? null}
    >
      {!ready ? (
        <Notice tone="warn">
          This page needs the database update <code>20261009180000_vendor_commercial_approval.sql</code> — run it in the Supabase SQL editor, then reload.
        </Notice>
      ) : (
        <VendorCommercialClient requests={requests} vendors={vendors} role={user.role} />
      )}
    </FormLayout>
  );
}
