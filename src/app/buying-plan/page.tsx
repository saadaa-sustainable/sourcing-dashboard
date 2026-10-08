import Link from 'next/link';
import { redirect } from 'next/navigation';
import { FormLayout, Notice } from '@/components/forms/form-layout';
import { addMonths, isPlanFrozen, monthLabel, monthStart } from '@/lib/forms/approval';
import {
  currentUser,
  loadActualsByProduct,
  loadAnalyticsRules,
  loadBuyingPlan,
  loadBuyingPlanAnalysis,
  loadBuyingPlanBoard,
  loadMaterialPlan,
  loadPlanFirstActionAt,
  loadPlanMonthStatuses,
  loadNpdBudget,
  loadProductCatalog,
  NotConfiguredError,
} from '@/lib/forms/queries';
import { loadStandardCostProductOptions } from '@/lib/temp-product.server';
import { BuyingPlanClient } from './buying-plan-client';
import { BuyingPlanAnalysisClient } from './buying-plan-analysis-client';
import { MaterialPlanClient } from './material-plan-client';
import { NpdBudgetCard } from './npd-budget-card';
import { type PlanType } from './plan-type-tabs';
import { PlanHeader, planFacts, type PlanMonthStatus } from './plan-header';
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

  // Months for the header's picker: every month with a plan on either track, plus last month,
  // this month and next month, plus the one being looked at.
  const statuses = await loadPlanMonthStatuses();
  const nowMonth = monthStart();
  const monthSet = new Set([...statuses.map((r) => r.month), addMonths(nowMonth, -1), nowMonth, addMonths(nowMonth, 1), planMonth]);
  const planMonths: PlanMonthStatus[] = [...monthSet]
    .sort()
    .map((m) => statuses.find((r) => r.month === m) ?? { month: m, fg: null, material: null });

  return (
    <FormLayout
      title="Buying Plan"
      active="/buying-plan"
      role={user.role}
      userEmail={user.email}
      allowedPages={user.allowed_pages ?? null}
    >
      {planType === 'analysis' ? (
        <>
          <PlanHeader
            planMonth={planMonth}
            planType="analysis"
            months={planMonths}
            facts={[
              <span key="what">Approved Finished goods plan vs POs actually issued</span>,
              ...planFacts(planMonth, null).slice(1),
            ]}
          />
          <AnalysisTrack planMonth={planMonth} isAdmin={user.role === 'admin'} />
        </>
      ) : planType === 'material' ? (
        <MaterialTrack planMonth={planMonth} role={user.role} startInInput={params.mode === 'input'} planMonths={planMonths} />
      ) : (
        <FgTrack planMonth={planMonth} role={user.role} startInInput={params.mode === 'input'} planMonths={planMonths} />
      )}
    </FormLayout>
  );
}

async function FgTrack({ planMonth, role, startInInput, planMonths }: { planMonth: string; role: 'viewer' | 'team' | 'admin'; startInInput: boolean; planMonths: PlanMonthStatus[] }) {
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
    <BuyingPlanClient
      planMonth={planMonth}
      planMonths={planMonths}
      // NPD budget shows only when a cap exists (the "not set" banner was dropped, 2026-10-08);
      // on a month that is over it is read-only. It sits under the header.
      afterHeader={npdBudget.cap != null ? <NpdBudgetCard budget={npdBudget} role={isPlanFrozen(planMonth) ? 'viewer' : role} /> : null}
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
      leadDays={{ job: rules.lead_days_job, efob: rules.lead_days_efob, fob: rules.lead_days_fob }}
      deadlineDay={rules.plan_approval_deadline_day ?? 7}
      firstActionAt={firstActionAt}
      role={role}
    />
  );
}

async function MaterialTrack({ planMonth, role, startInInput, planMonths }: { planMonth: string; role: 'viewer' | 'team' | 'admin'; startInInput: boolean; planMonths: PlanMonthStatus[] }) {
  const { plan, lines, materialCodes, colours, materialCosts } = await loadMaterialPlan(planMonth);
  return (
    <MaterialPlanClient
      planMonth={planMonth}
      planMonths={planMonths}
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
