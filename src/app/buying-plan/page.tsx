import Link from 'next/link';
import { redirect } from 'next/navigation';
import { FormLayout, Notice } from '@/components/forms/form-layout';
import { addMonths, monthLabel, monthStart } from '@/lib/forms/approval';
import {
  currentUser,
  loadActualsByProduct,
  loadAnalyticsRules,
  loadBuyingPlan,
  loadBuyingPlanAnalysis,
  loadBuyingPlanBoard,
  loadMaterialPlan,
  loadPlanFirstActionAt,
  loadNpdBudget,
  loadProductCatalog,
  NotConfiguredError,
} from '@/lib/forms/queries';
import { loadStandardCostProductOptions } from '@/lib/temp-product.server';
import { BuyingPlanClient } from './buying-plan-client';
import { BuyingPlanAnalysisClient } from './buying-plan-analysis-client';
import { MaterialPlanClient } from './material-plan-client';
import { NpdBudgetCard } from './npd-budget-card';
import { PlanTypeTabs, type PlanType } from './plan-type-tabs';
import { MonthBoard } from '@/components/month-board';

export const dynamic = 'force-dynamic';

export default async function BuyingPlanPage({
  searchParams,
}: {
  searchParams: Promise<{ month?: string; type?: string; track?: string; mode?: string }>;
}) {
  const params = await searchParams;
  const planMonth = /^\d{4}-\d{2}-01$/.test(params.month ?? '')
    ? params.month!
    : monthStart();
  // `type` is canonical; `track` is accepted too (older approval links used it).
  const requested = params.type ?? params.track;
  const planType: PlanType =
    requested === 'material' ? 'material' : requested === 'analysis' ? 'analysis' : 'fg';

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

  // No month or track asked for: the landing view is the month board, one card per plan.
  if (!params.month && !requested) {
    const rules = await loadAnalyticsRules();
    const board = await loadBuyingPlanBoard(Math.min(28, Math.max(1, Math.round(rules.plan_approval_deadline_day ?? 7))));
    const next = addMonths(monthStart(), 1);
    return (
      <FormLayout
        title="Buying Plan"
        subtitle="Every month's plan, FG and fabric / material, by where it stands. Open a card to fill, review or analyse that month."
        active="/buying-plan"
        role={user.role}
        userEmail={user.email}
        allowedPages={user.allowed_pages ?? null}
      >
        <MonthBoard
          data={board}
          searchPlaceholder="Search month or track…"
          pageBar={
            user.role !== 'viewer' ? (
              <Link className="wf-btn wf-btn-primary wf-btn-sm" href={`/buying-plan?month=${next}&type=fg&mode=input`}>
                + Plan {monthLabel(next)}
              </Link>
            ) : null
          }
        />
      </FormLayout>
    );
  }

  const subtitle =
    planType === 'analysis'
      ? `Buying Plan Analysis — ${monthLabel(planMonth)}. Approved plan vs POs actually issued: quantity, value and PO-count variance, excess / short, and the exceptions (issued but not budgeted; issued above approved).`
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
      <Link className="mb-back" href="/buying-plan">← All months</Link>
      <PlanTypeTabs planMonth={planMonth} planType={planType} />
      {planType === 'analysis' ? (
        <AnalysisTrack planMonth={planMonth} isAdmin={user.role === 'admin'} />
      ) : planType === 'material' ? (
        <MaterialTrack planMonth={planMonth} role={user.role} startInInput={params.mode === 'input'} />
      ) : (
        <FgTrack planMonth={planMonth} role={user.role} startInInput={params.mode === 'input'} />
      )}
    </FormLayout>
  );
}

async function FgTrack({ planMonth, role, startInInput }: { planMonth: string; role: 'viewer' | 'team' | 'admin'; startInInput: boolean }) {
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
  // Rules-Master toggle (default on): restrict the add-product picker to products that
  // exist in Standard Cost (real + temp), instead of the full EasyEcom catalog.
  const restrictToStandardCost = (rules.restrict_plan_po_to_standard_cost ?? 1) >= 1;
  const pickerItems = restrictToStandardCost ? await loadStandardCostProductOptions() : catalog;
  // First admin decision on the plan — the approval deadline measures this, not approval alone.
  const firstActionAt = plan?.id ? await loadPlanFirstActionAt(plan.id) : null;
  return (
    <>
    <NpdBudgetCard budget={npdBudget} role={role} />
    <BuyingPlanClient
      planMonth={planMonth}
      startInInput={startInInput}
      plan={plan}
      lines={lines}
      productCodes={productCodes}
      productMaster={productMaster}
      standardCosts={standardCosts}
      pendingByCode={pendingByCode}
      actuals={Object.fromEntries(actualsMap)}
      catalog={catalog}
      pickerItems={pickerItems}
      restrictPicker={restrictToStandardCost}
      npdBudgetSet={npdBudget.cap != null}
      leadDays={{ job: rules.lead_days_job, efob: rules.lead_days_efob, fob: rules.lead_days_fob }}
      deadlineDay={rules.plan_approval_deadline_day ?? 7}
      firstActionAt={firstActionAt}
      role={role}
    />
    </>
  );
}

async function MaterialTrack({ planMonth, role, startInInput }: { planMonth: string; role: 'viewer' | 'team' | 'admin'; startInInput: boolean }) {
  const { plan, lines, materialCodes, colours, materialCosts } = await loadMaterialPlan(planMonth);
  return (
    <MaterialPlanClient
      planMonth={planMonth}
      startInInput={startInInput}
      plan={plan}
      lines={lines}
      materialCodes={materialCodes}
      colours={colours}
      materialCosts={materialCosts}
      role={role}
    />
  );
}

// Buying Plan Analysis: month-filtered variance between the approved FG plan and the
// POs actually issued (real EasyEcom POs), plus the two exception lists. Read-only,
// derived at request time — no data of its own.
async function AnalysisTrack({ planMonth, isAdmin }: { planMonth: string; isAdmin: boolean }) {
  const analysis = await loadBuyingPlanAnalysis(planMonth);
  return <BuyingPlanAnalysisClient analysis={analysis} isAdmin={isAdmin} />;
}
