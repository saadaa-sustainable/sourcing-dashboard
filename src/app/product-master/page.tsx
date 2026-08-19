import { redirect } from 'next/navigation';
import { FormLayout, Notice } from '@/components/forms/form-layout';
import {
  currentUser,
  loadGcpProductMaster,
  NotConfiguredError,
} from '@/lib/forms/queries';
import { ProductMasterClient } from './product-master-client';

export const dynamic = 'force-dynamic';

export default async function ProductMasterPage() {
  let user;
  try {
    user = await currentUser();
  } catch (error) {
    if (error instanceof NotConfiguredError) {
      return (
        <FormLayout title="Product Master" active="/product-master" role="viewer">
          <Notice tone="error">{error.message}</Notice>
        </FormLayout>
      );
    }
    throw error;
  }

  if (!user) redirect('/login');

  const products = await loadGcpProductMaster();

  return (
    <FormLayout
      title="Product Master"
      subtitle="SKU-level product master from GCP (saadaa_consolidated_product_master) — status, category, fabric, RM, launch date and pricing. Read-only, refreshed daily."
      active="/product-master"
      role={user.role}
      userEmail={user.email}
    >
      <ProductMasterClient products={products} />
    </FormLayout>
  );
}
