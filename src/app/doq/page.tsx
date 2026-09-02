import { redirect } from 'next/navigation';
import { FormLayout, Notice } from '@/components/forms/form-layout';
import {
  currentUser,
  loadDoqDataset,
  loadOosMeta,
  NotConfiguredError,
} from '@/lib/forms/queries';
import { DoqClient } from './doq-client';

export const dynamic = 'force-dynamic';

export default async function DoqPage() {
  let user;
  try {
    user = await currentUser();
  } catch (error) {
    if (error instanceof NotConfiguredError) {
      return (
        <FormLayout title="DOQ Dataset" active="/doq" role="viewer">
          <Notice tone="error">{error.message}</Notice>
        </FormLayout>
      );
    }
    throw error;
  }

  if (!user) redirect('/login');

  const [rows, meta] = await Promise.all([loadDoqDataset(), loadOosMeta()]);

  return (
    <FormLayout
      title="DOQ Dataset"
      subtitle="The full daily DOQ snapshot from BigQuery (sd_inventory_planning): one row per SKU × warehouse with stock, in-process, sales windows and every doq_* / oos_days_* figure. Read-only, refreshed daily."
      active="/doq"
      role={user.role}
      userEmail={user.email}
      allowedPages={user.allowed_pages ?? null}
    >
      <DoqClient rows={rows} dataAsOf={meta.dataAsOf} lastSynced={meta.lastSynced} />
    </FormLayout>
  );
}
