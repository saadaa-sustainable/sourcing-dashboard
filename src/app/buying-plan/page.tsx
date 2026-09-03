import { redirect } from 'next/navigation';
import { FormLayout, Notice } from '@/components/forms/form-layout';
import { monthLabel, monthStart } from '@/lib/forms/approval';
import {
  currentUser,
  loadActualsByProduct,
  loadAnalyticsRules,
  loadBuyingPlan,
  loadInwardPlanSheet,
  loadMaterialPlan,
  loadNpdBudget,
  loadProductCatalog,
  NotConfiguredError,
} from '@/lib/forms/queries';
import { BuyingPlanClient } from './buying-plan-client';
import { MaterialPlanClient } from './material-plan-client';
import { InwardPlanIiClient } from './inward-plan-ii-client';
import { NpdBudgetCard } from './npd-budget-card';
import { PlanTypeTabs, type PlanType } from './plan-type-tabs';

export const dynamic = 'force-dynamic';

export default async function BuyingPlanPage({
  searchParams,
}: {
  searchParams: Promise<{ month?: string; type?: string }>;
}) {
  const params = await searchParams;
  const planMonth = /^\d{4}-\d{2}-01$/.test(params.month ?? '')
    ? params.month!
    : monthStart();
  const planType: PlanType =
    params.type === 'material' ? 'material' : params.type === 'inward' ? 'inward' : 'fg';

  let user;
  try {
    user = await currentUser();
  } catch (error) {
    if (error instanceof NotConfiguredError) {
      return (
        <FormLayout title="Buying Plan" active="/buying-plan" role="viewer">
          <Notice tone="error">{error.message}</Notice>
        </FormLayout>
      );
    }
    throw error;
  }

  if (!user) redirect('/login');
  if (!user.email.endsWith('@saadaa.in')) {
    redirect('/login?error=This+dashboard+is+restricted+to+SAADAA+accounts.');
  }

  const subtitle =
    planType === 'inward'
      ? `Inward Plan II — ${monthLabel(planMonth)}. The team's monthly inward sheet: what to inward against which PO, with management review.`
      : `Monthly buying budget — ${monthLabel(planMonth)}. ${
          planType === 'material' ? 'Fabric / material track.' : 'Finished-goods track.'
        } Submitted for approval before POs are issued.`;

  return (
    <FormLayout
      title="Buying Plan"
      subtitle={subtitle}
      active="/buying-plan"
      role={user.role}
      userEmail={user.email}
      allowedPages={user.allowed_pages ?? null}
    >
      <PlanTypeTabs planMonth={planMonth} planType={planType} />
      {planType === 'material' ? (
        <MaterialTrack planMonth={planMonth} role={user.role} />
      ) : planType === 'inward' ? (
        <InwardTrack planMonth={planMonth} role={user.role} />
      ) : (
        <FgTrack planMonth={planMonth} role={user.role} />
      )}
    </FormLayout>
  );
}

async function FgTrack({ planMonth, role }: { planMonth: string; role: 'viewer' | 'team' | 'admin' }) {
  const [
    { plan, lines, productCodes, productMaster, standardCosts, pendingByCode },
    actualsMap,
    catalog,
    rules,
    npdBudget,
  ] = await Promise.all([
    loadBuyingPlan(planMonth),
    loadActualsByProduct(planMonth),
    loadProductCatalog(),
    loadAnalyticsRules(),
    loadNpdBudget(planMonth),
  ]);
  return (
    <>
    <NpdBudgetCard budget={npdBudget} role={role} />
    <BuyingPlanClient
      planMonth={planMonth}
      plan={plan}
      lines={lines}
      productCodes={productCodes}
      productMaster={productMaster}
      standardCosts={standardCosts}
      pendingByCode={pendingByCode}
      actuals={Object.fromEntries(actualsMap)}
      catalog={catalog}
      leadDays={{ job: rules.lead_days_job, efob: rules.lead_days_efob, fob: rules.lead_days_fob }}
      role={role}
    />
    </>
  );
}

async function MaterialTrack({ planMonth, role }: { planMonth: string; role: 'viewer' | 'team' | 'admin' }) {
  const { plan, lines, materialCodes, colours, materialCosts } = await loadMaterialPlan(planMonth);
  return (
    <MaterialPlanClient
      planMonth={planMonth}
      plan={plan}
      lines={lines}
      materialCodes={materialCodes}
      colours={colours}
      materialCosts={materialCosts}
      role={role}
    />
  );
}

async function InwardTrack({ planMonth, role }: { planMonth: string; role: 'viewer' | 'team' | 'admin' }) {
  const { entries, catalog } = await loadInwardPlanSheet(planMonth);
  return (
    <InwardPlanIiClient planMonth={planMonth} entries={entries} catalog={catalog} role={role} />
  );
}
