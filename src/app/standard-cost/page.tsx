import { redirect } from 'next/navigation';
import { FormLayout, Notice } from '@/components/forms/form-layout';
import {
  currentUser,
  loadMaterialStandardCosts,
  loadStandardCostLines,
  loadStandardCosts,
  NotConfiguredError,
} from '@/lib/forms/queries';
import { StandardCostClient } from './standard-cost-client';
import { CostTrackTabs } from './cost-track-tabs';

export const dynamic = 'force-dynamic';

export default async function StandardCostPage({
  searchParams,
}: {
  searchParams: Promise<{ track?: string }>;
}) {
  const track = (await searchParams).track === 'material' ? 'material' : 'fg';

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

  const [costs, lines] =
    track === 'material'
      ? [await loadMaterialStandardCosts(), []]
      : await Promise.all([loadStandardCosts(), loadStandardCostLines()]);

  return (
    <FormLayout
      title="Standard Cost"
      subtitle={
        track === 'material'
          ? 'Job Work / Purchase rates per material. Approved rates value the Buying Plan material track.'
          : 'Final job / FOB / E-FOB rates per product. Approved rates drive the Buying Plan value; frozen at first PO issuance.'
      }
      active="/standard-cost"
      role={user.role}
      userEmail={user.email}
      accent="purple"
    >
      <CostTrackTabs track={track} />
      <StandardCostClient costs={costs} lines={lines} role={user.role} track={track} />
    </FormLayout>
  );
}
