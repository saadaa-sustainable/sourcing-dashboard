import { redirect } from 'next/navigation';
import { FormLayout, Notice } from '@/components/forms/form-layout';
import {
  currentUser,
  loadStandardCosts,
  NotConfiguredError,
} from '@/lib/forms/queries';
import { StandardCostClient } from './standard-cost-client';

export const dynamic = 'force-dynamic';

export default async function StandardCostPage() {
  let user;
  try {
    user = await currentUser();
  } catch (error) {
    if (error instanceof NotConfiguredError) {
      return (
        <FormLayout title="Standard Cost" active="/standard-cost" role="viewer">
          <Notice tone="error">{error.message}</Notice>
        </FormLayout>
      );
    }
    throw error;
  }

  if (!user) redirect('/login');

  const costs = await loadStandardCosts();

  return (
    <FormLayout
      title="Standard Cost"
      subtitle="Final job / FOB / E-FOB rates per product. Approved rates drive the Buying Plan value; frozen at first PO issuance."
      active="/standard-cost"
      role={user.role}
      userEmail={user.email}
    >
      <StandardCostClient costs={costs} role={user.role} />
    </FormLayout>
  );
}
