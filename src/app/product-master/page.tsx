import { redirect } from 'next/navigation';
import { FormLayout, Notice } from '@/components/forms/form-layout';
import {
  currentUser,
  loadEeProductMaster,
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

  const products = await loadEeProductMaster();

  return (
    <FormLayout
      title="Product Master"
      subtitle="SKU-level product master from EasyEcom (Easyecom_new_product_master + custom fields) — status, category, fabric, attributes and pricing. Read-only, refreshed daily."
      active="/product-master"
      role={user.role}
      userEmail={user.email}
      allowedPages={user.allowed_pages ?? null}
    >
      <ProductMasterClient products={products} />
    </FormLayout>
  );
}
