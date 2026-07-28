import { redirect } from 'next/navigation';
import { FormLayout, Notice } from '@/components/forms/form-layout';
import {
  currentUser,
  loadProductMaster,
  NotConfiguredError,
} from '@/lib/forms/queries';
import { canEdit } from '@/lib/forms/approval';
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

  const products = await loadProductMaster();

  return (
    <FormLayout
      title="Product Master"
      subtitle="Product status and Woven/Knitted — the source of truth the Buying Plan reads."
      active="/product-master"
      role={user.role}
      userEmail={user.email}
    >
      <ProductMasterClient products={products} editable={canEdit(user.role, 'draft')} />
    </FormLayout>
  );
}
