import { redirect } from 'next/navigation';
import { FormLayout, Notice } from '@/components/forms/form-layout';
import {
  currentUser,
  loadDiscontinueRequests,
  loadDiscontinuedInventory,
  NotConfiguredError,
} from '@/lib/forms/queries';
import { DiscontinueTabs } from './discontinue-tabs';

export const dynamic = 'force-dynamic';

export default async function DiscontinuePage() {
  let user;
  try {
    user = await currentUser();
  } catch (error) {
    if (error instanceof NotConfiguredError) {
      return (
        <FormLayout title="Discontinued Products View" active="/discontinue" role="viewer">
          <Notice tone="error">{error.message}</Notice>
        </FormLayout>
      );
    }
    throw error;
  }

  if (!user) redirect('/login');

  const [{ requests, variants }, inventory] = await Promise.all([
    loadDiscontinueRequests(),
    loadDiscontinuedInventory(),
  ]);

  return (
    <FormLayout
      title="Discontinued Products View"
      subtitle="Variant-level discontinue approval, plus the available-inventory ageing & liquidation view."
      active="/discontinue"
      role={user.role}
      userEmail={user.email}
    >
      <DiscontinueTabs
        requests={requests}
        variants={variants}
        role={user.role}
        invRows={inventory.rows}
        salesByVariant={inventory.salesByVariant}
      />
    </FormLayout>
  );
}
