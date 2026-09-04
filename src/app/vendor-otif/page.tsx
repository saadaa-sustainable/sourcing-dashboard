import { redirect } from 'next/navigation';
import { FormLayout, Notice } from '@/components/forms/form-layout';
import { currentUser, loadVendorOtif, NotConfiguredError } from '@/lib/forms/queries';
import { VendorOtifClient } from './vendor-otif-client';

export const dynamic = 'force-dynamic';

// Item 2 — OTIF (On Time In Full) vendor scorecard: three separately-tracked
// variables (Critical Path lives on the Open PO Tracker; On-Time + Fill Rate
// here) combined into a joint pass/fail OTIF per vendor.
export default async function VendorOtifPage() {
  let user;
  try {
    user = await currentUser();
  } catch (error) {
    if (error instanceof NotConfiguredError) {
      return (
        <FormLayout title="Vendor OTIF" active="/vendor-otif" role="viewer">
          <Notice tone="error">{error.message}</Notice>
        </FormLayout>
      );
    }
    throw error;
  }

  if (!user) redirect('/login');

  const otif = await loadVendorOtif();

  return (
    <FormLayout
      title="Vendor OTIF"
      subtitle="On Time In Full per vendor — On-Time and In-Full tracked separately, then combined as a joint pass/fail per PO. Critical-Path (TNA stage) compliance is on the Open PO Tracker."
      active="/vendor-otif"
      role={user.role}
      userEmail={user.email}
      allowedPages={user.allowed_pages ?? null}
    >
      <VendorOtifClient windowDays={otif.windowDays} vendors={otif.vendors} />
    </FormLayout>
  );
}
