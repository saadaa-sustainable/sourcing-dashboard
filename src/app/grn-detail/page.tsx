import { redirect } from 'next/navigation';
import { FormLayout, Notice } from '@/components/forms/form-layout';
import {
  currentUser,
  loadGrnDetail,
  grnDetailLimit,
  NotConfiguredError,
} from '@/lib/forms/queries';
import { GrnDetailClient } from './grn-detail-client';

export const dynamic = 'force-dynamic';

export default async function GrnDetailPage() {
  let user;
  try {
    user = await currentUser();
  } catch (error) {
    if (error instanceof NotConfiguredError) {
      return (
        <FormLayout title="GRN Detail" active="/grn-detail" role="viewer">
          <Notice tone="error">{error.message}</Notice>
        </FormLayout>
      );
    }
    throw error;
  }

  if (!user) redirect('/login');

  const rows = await loadGrnDetail();

  return (
    <FormLayout
      title="GRN Detail"
      subtitle="Inbound-QC GRN lines from EasyEcom (sd_ee_grn): received vs. QC-passed/failed/pending and the damage/discard/return dispositions per line. Read-only, refreshed daily."
      active="/grn-detail"
      role={user.role}
      userEmail={user.email}
    >
      <GrnDetailClient rows={rows} limit={grnDetailLimit} />
    </FormLayout>
  );
}
