import { redirect } from 'next/navigation';
import { FormLayout, Notice } from '@/components/forms/form-layout';
import {
  currentUser,
  loadVendorMaster,
  NotConfiguredError,
} from '@/lib/forms/queries';
import { VendorMasterClient } from './vendor-master-client';

export const dynamic = 'force-dynamic';

export default async function VendorMasterPage() {
  let user;
  try {
    user = await currentUser();
  } catch (error) {
    if (error instanceof NotConfiguredError) {
      return (
        <FormLayout title="Vendor Master" active="/vendor-master" role="viewer">
          <Notice tone="error">{error.message}</Notice>
        </FormLayout>
      );
    }
    throw error;
  }

  if (!user) redirect('/login');

  const rows = await loadVendorMaster();

  return (
    <FormLayout
      title="Vendor Master"
      subtitle="Vendor identity and EasyEcom status as fetched from GCP (vendor_master_data). Read-only."
      active="/vendor-master"
      role={user.role}
      userEmail={user.email}
      allowedPages={user.allowed_pages ?? null}
    >
      <VendorMasterClient rows={rows} />
    </FormLayout>
  );
}
