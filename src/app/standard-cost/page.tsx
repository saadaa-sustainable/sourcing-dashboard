import { redirect } from 'next/navigation';
import { FormLayout, Notice } from '@/components/forms/form-layout';
import {
  currentUser,
  loadCmtpComponents,
  loadCmtpSubitems,
  loadCostStandards,
  loadEfobFabricCost,
  loadFabricCostBase,
  loadMaterialStandardCosts,
  loadProductCatalog,
  loadStandardCostLines,
  loadStandardCostRateHistory,
  loadStandardCosts,
  NotConfiguredError,
} from '@/lib/forms/queries';
import { StandardCostClient } from './standard-cost-client';
import { CostTrackTabs } from './cost-track-tabs';
import type { StandardCostRateHistory } from '@/lib/forms/types';
import { loadCmtpRevisions } from '@/lib/standard-cost-revisions.server';

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

  const [costs, lines, fabricBase, standards, cmtp, efob, catalog, rateHistory, cmtpSubitems] =
    track === 'material'
      ? [await loadMaterialStandardCosts(), [], [], await loadCostStandards(), [], [], [], {}, {}]
      : await Promise.all([
          loadStandardCosts(),
          loadStandardCostLines(),
          loadFabricCostBase(),
          loadCostStandards(),
          loadCmtpComponents(),
          loadEfobFabricCost(),
          loadProductCatalog(),
          loadStandardCostRateHistory(),
          loadCmtpSubitems(),
        ]);

  // Item 2 — line-item CMTP revision audit (FG track only; material CMTP isn't a
  // thing). Keyed by product_code, shown in the Rate History view.
  const cmtpRevisions =
    track === 'material' ? {} : await loadCmtpRevisions(costs.map((c) => c.product_code));

  // Fabric buildup map (grey / processing / finished) + code list — the Fabric
  // Cost tab references these read-only from the Fabric Cost master.
  const fabricByCode: Record<string, { grey: number | null; processing: number | null; finished: number | null }> = {};
  const fabricCodes: string[] = [];
  for (const f of fabricBase) {
    fabricCodes.push(f.fabric_code);
    fabricByCode[f.fabric_code] = {
      grey: f.grey_rate != null ? Number(f.grey_rate) : null,
      processing: f.processing_cost != null ? Number(f.processing_cost) : null,
      finished: f.finished_fabric_cost != null ? Number(f.finished_fabric_cost) : null,
    };
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
      allowedPages={user.allowed_pages ?? null}
      accent="purple"
    >
      <CostTrackTabs track={track} />
      <StandardCostClient
        costs={costs}
        lines={lines}
        cmtp={cmtp}
        cmtpSubitems={cmtpSubitems as Record<string, string[]>}
        fabricBase={fabricByCode}
        fabricCodes={fabricCodes}
        standards={standards}
        efob={efob}
        catalog={catalog}
        rateHistory={rateHistory as Record<string, StandardCostRateHistory[]>}
        cmtpRevisions={cmtpRevisions}
        initialOpen={openCode}
        role={user.role}
        track={track}
      />
    </FormLayout>
  );
}
