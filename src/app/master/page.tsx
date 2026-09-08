import { redirect } from 'next/navigation';
import { FormLayout, Notice } from '@/components/forms/form-layout';
import {
  currentUser,
  loadEeProductMaster,
  loadVendorMaster,
  loadFabricMaster,
  loadMaterialMaster,
  loadFabricCostBase,
  NotConfiguredError,
} from '@/lib/forms/queries';
import { canEdit } from '@/lib/forms/approval';
import { canView } from '@/lib/views';
import { loadCategoryMapState } from '@/lib/category-mapping.server';
import { loadFabricRateSubmissionState } from '@/lib/fabric-rate-submission.server';
import { ProductMasterClient } from '../product-master/product-master-client';
import { VendorMasterClient } from '../vendor-master/vendor-master-client';
import { FabricMasterClient } from '../fabric-master/fabric-master-client';
import { MaterialMasterClient } from '../material-master/material-master-client';
import { CategoryMappingClient } from '../category-mapping/category-mapping-client';
import { FabricCostClient } from '../fabric-cost/fabric-cost-client';
import { FabricRateSubmissionPanel } from '@/components/forms/fabric-rate-submission-panel';
import { MasterTabs, MASTER_TABS } from './master-tabs';

export const dynamic = 'force-dynamic';

// One "Master" hub with a tab per master — reuses each master's existing loader
// and client, so nothing about the individual screens changes; they just live
// under one nav item now. The legacy /product-master, /vendor-master … routes
// stay reachable (deep links + the "Edit on Fabric Cost →" style links).
const SUBTITLE: Record<string, string> = {
  product: 'SKU-level product master from EasyEcom — status, category, fabric, attributes and pricing. Read-only, refreshed daily.',
  category: 'The authoritative category / sub-category per product code — mandatory; every zoomed-out view slices by it.',
  vendor: 'The EasyEcom vendor master from GCP — every field, no Google-Sheet data. Read-only.',
  fabric: 'Fabric composition codes with duplicate prevention — the source the Buying Plan material track picks from.',
  material: 'One code list for Raw, Dyed and Trim materials — the source the Buying Plan material track picks from.',
  'fabric-cost': 'Fabric cost base — grey rate, processing and finished fabric cost, plus the monthly rate submission.',
};

export default async function MasterPage({
  searchParams,
}: {
  searchParams: Promise<{ tab?: string }>;
}) {
  const { tab: tabParam } = await searchParams;
  const tab = MASTER_TABS.some((t) => t.id === tabParam) ? tabParam! : 'product';

  let user;
  try {
    user = await currentUser();
  } catch (error) {
    if (error instanceof NotConfiguredError) {
      return (
        <FormLayout title="Master" active="/master" role="viewer">
          <Notice tone="error">{error.message}</Notice>
        </FormLayout>
      );
    }
    throw error;
  }

  if (!user) redirect('/login');

  const role = user.role;
  const allowedPages = user.allowed_pages ?? null;
  const active = MASTER_TABS.find((t) => t.id === tab)!;
  const editable = canEdit(role, 'draft');

  // Render the active master only if the user can see that specific master.
  let body: React.ReactNode;
  if (!canView(active.route, role, allowedPages)) {
    body = (
      <Notice tone="error">
        Your roles don&apos;t include the {active.label} master. Ask an admin to grant it.
      </Notice>
    );
  } else if (tab === 'product') {
    body = <ProductMasterClient products={await loadEeProductMaster()} />;
  } else if (tab === 'vendor') {
    body = <VendorMasterClient rows={await loadVendorMaster()} />;
  } else if (tab === 'fabric') {
    body = <FabricMasterClient fabrics={await loadFabricMaster()} editable={editable} />;
  } else if (tab === 'material') {
    const { materials, colours, fabricCodes } = await loadMaterialMaster();
    body = (
      <MaterialMasterClient
        materials={materials}
        colours={colours}
        fabricCodes={fabricCodes}
        initialType="dyed"
        editable={editable}
      />
    );
  } else if (tab === 'category') {
    const state = await loadCategoryMapState();
    body = (
      <CategoryMappingClient
        rows={state.rows}
        missingCount={state.missingCount}
        categoryOptions={state.categoryOptions}
        subCategoryOptions={state.subCategoryOptions}
        editable={editable}
      />
    );
  } else {
    // fabric-cost
    const [rows, submissionState] = await Promise.all([
      loadFabricCostBase(),
      loadFabricRateSubmissionState(),
    ]);
    body = (
      <>
        <section style={{ marginBottom: 24 }}>
          <h2 className="wf-section-title">Monthly rate submission</h2>
          <FabricRateSubmissionPanel
            month={submissionState.month}
            rows={submissionState.rows}
            pendingCount={submissionState.pendingCount}
            editable={editable}
          />
        </section>
        <FabricCostClient rows={rows} editable={editable} />
      </>
    );
  }

  return (
    <FormLayout
      title="Master"
      subtitle={SUBTITLE[tab]}
      active="/master"
      helpRoute={active.route}
      role={role}
      userEmail={user.email}
      allowedPages={allowedPages}
    >
      <MasterTabs active={tab} role={role} allowedPages={allowedPages} />
      {body}
    </FormLayout>
  );
}
