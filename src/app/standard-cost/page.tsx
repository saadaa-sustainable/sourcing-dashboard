import { redirect } from 'next/navigation';
import { FormLayout, Notice } from '@/components/forms/form-layout';
import {
  currentUser,
  loadCostStandards,
  loadFabricCostBase,
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
  searchParams: Promise<{ track?: string; open?: string }>;
}) {
  const params = await searchParams;
  const track = params.track === 'material' ? 'material' : 'fg';
  const openCode = params.open ?? null;

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

  const [costs, lines, fabricBase, standards] =
    track === 'material'
      ? [await loadMaterialStandardCosts(), [], [], await loadCostStandards()]
      : await Promise.all([
          loadStandardCosts(),
          loadStandardCostLines(),
          loadFabricCostBase(),
          loadCostStandards(),
        ]);

  // Fabric rate map (finished fabric cost) + code list, for the CM matrix's
  // auto-pulled Fabric column.
  const fabricRates: Record<string, number> = {};
  const fabricCodes: string[] = [];
  for (const f of fabricBase) {
    fabricCodes.push(f.fabric_code);
    if (f.finished_fabric_cost != null) fabricRates[f.fabric_code] = Number(f.finished_fabric_cost);
  }

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
      <StandardCostClient
        costs={costs}
        lines={lines}
        fabricRates={fabricRates}
        fabricCodes={fabricCodes}
        standards={standards}
        initialOpen={openCode}
        role={user.role}
        track={track}
      />
    </FormLayout>
  );
}
