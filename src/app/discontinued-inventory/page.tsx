import { redirect } from 'next/navigation';
import { FormLayout, Notice } from '@/components/forms/form-layout';
import {
  currentUser,
  loadDiscontinuedInventory,
  NotConfiguredError,
} from '@/lib/forms/queries';
import { DiscontinuedInventoryClient } from './discontinued-inventory-client';

export const dynamic = 'force-dynamic';

export default async function DiscontinuedInventoryPage() {
  let user;
  try {
    user = await currentUser();
  } catch (error) {
    if (error instanceof NotConfiguredError) {
      return (
        <FormLayout title="Discontinued Inventory" active="/discontinued-inventory" role="viewer">
          <Notice tone="error">{error.message}</Notice>
        </FormLayout>
      );
    }
    throw error;
  }

  if (!user) redirect('/login');

  const { rows, salesByVariant } = await loadDiscontinuedInventory();

  return (
    <FormLayout
      title="Discontinued Inventory"
      subtitle="Ageing & liquidation view of discontinued-product stock — suggested discount and recommended action per SKU."
      active="/discontinued-inventory"
      role={user.role}
      userEmail={user.email}
    >
      <DiscontinuedInventoryClient rows={rows} salesByVariant={salesByVariant} />
    </FormLayout>
  );
}
