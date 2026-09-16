import { redirect } from 'next/navigation';
import { FormLayout, Notice } from '@/components/forms/form-layout';
import {
  currentUser,
  loadCostStandards,
  loadEfobFabricCost,
  loadMaterialCodeInfo,
  loadMaterialStandardCosts,
  loadProductCatalog,
  loadStandardCostRateHistory,
  loadMaterialStandardCostRateHistory,
  loadStandardCosts,
  loadHiddenStandardCostCodes,
  NotConfiguredError,
} from '@/lib/forms/queries';
import { StandardCostClient } from './standard-cost-client';
import { CostTrackTabs } from './cost-track-tabs';
import type { StandardCostRateHistory } from '@/lib/forms/types';
import { loadTempProductMap } from '@/lib/temp-product.server';

export const dynamic = 'force-dynamic';

export default async function StandardCostPage({
  searchParams,
}: {
  searchParams: Promise<{ track?: string; open?: string }>;
}) {
  const params = await searchParams;
  const track = params.track === 'material' ? 'material' : 'fg';
  const openCode = params.open ?? null;
  // Older links used ?open=CODE to expand a row. The record has its own page now.
  if (openCode) {
    redirect(
      `/standard-cost/${encodeURIComponent(openCode)}${track === 'material' ? '?track=material' : ''}`,
    );
  }

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

  // The list is cards now: code, name, three rates, when the cost was last accepted. The
  // cost sheet itself (CMTP lines, fabric buildup, revisions, margin) belongs to one
  // product's page, so none of it is fetched or shipped to the browser here any more.
  const [costs, standards, efob, catalog, rateHistory] =
    track === 'material'
      ? [
          await loadMaterialStandardCosts(),
          await loadCostStandards(),
          await loadEfobFabricCost(),
          [],
          await loadMaterialStandardCostRateHistory(),
        ]
      : await Promise.all([
          loadStandardCosts(),
          loadCostStandards(),
          loadEfobFabricCost(),
          loadProductCatalog(),
          loadStandardCostRateHistory(),
        ]);

  // Soft-deleted codes for this track — re-adding one restores it (un-hide) with data intact.
  const hiddenCodes = await loadHiddenStandardCostCodes(track === 'material');

  // Material cards show what a code IS ("Cotton Slub · Indigo · Dyed"), from the material master.
  const materialNames = track === 'material' ? await loadMaterialCodeInfo() : {};

  // Temporary products (minted here for items not yet in EasyEcom) — badge + merge (FG).
  const tempProducts = track === 'material' ? {} : await loadTempProductMap();

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
      allowedPages={user.allowed_pages ?? null}
      accent="purple"
    >
      <CostTrackTabs track={track} />
      <StandardCostClient
        costs={costs}
        standards={standards}
        efob={efob}
        catalog={catalog}
        rateHistory={rateHistory as Record<string, StandardCostRateHistory[]>}
        hiddenCodes={hiddenCodes}
        tempProducts={tempProducts}
        materialNames={materialNames}
        role={user.role}
        track={track}
      />
    </FormLayout>
  );
}
