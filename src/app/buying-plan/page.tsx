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
import { VariationReportPanel } from '@/components/variation-report';
import { buyingPlanVariation, materialPlanVariation } from '@/lib/forms/queries-modules/variation-reports';

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
  /*if (!params.month && !requested) {
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
  }*/
  
  // Draft Buying Plan: ask which month the user wants to create/edit.
  
  // Draft Buying Plan: select the planning month and track.
  if (params.mode === 'draft' && !params.month) {
    const currentMonth = monthStart();

    const draftMonths = Array.from({ length: 12 }, (_, i) =>
      addMonths(currentMonth, i)
    );

    return (
      <FormLayout
        title="Draft a buying plan"
        subtitle="Choose the month and type for the buying plan you want to create."
        active="/buying-plan"
        role={user.role}
        userEmail={user.email}
        allowedPages={user.allowed_pages ?? null}
      >
        <div className="draft-plan-form">
          <form action="/buying-plan" method="GET" className="draft-plan-card">
            <input type="hidden" name="mode" value="input" />

            {/* Planning month */}
            <div className="draft-plan-field">
              <label htmlFor="draft-month" className="draft-plan-label">
                Planning month
              </label>

              <select
                id="draft-month"
                name="month"
                defaultValue={addMonths(currentMonth, 1)}
                className="draft-plan-month"
                required
              >
                {draftMonths.map((month) => (
                  <option key={month} value={month}>
                    {monthLabel(month)}
                  </option>
                ))}
              </select>
            </div>

            {/* Plan type */}
            <fieldset className="draft-plan-field draft-plan-types">
              <legend className="draft-plan-label">Plan type</legend>

              <label className="draft-plan-option">
                <input
                  type="radio"
                  name="type"
                  value="fg"
                  defaultChecked
                />

                <span className="draft-plan-option-content">
                  <strong>Finished Goods (FG)</strong>
                </span>
              </label>

              <label className="draft-plan-option">
                <input
                  type="radio"
                  name="type"
                  value="material"
                />

                <span className="draft-plan-option-content">
                  <strong>Fabric / Material</strong>
                </span>
              </label>
            </fieldset>

            {/* Actions */}
            <div className="draft-plan-actions">
              <Link href="/buying-plan" className="draft-plan-cancel">
                Cancel
              </Link>

              <button type="submit" className="draft-plan-continue">
                Continue <span aria-hidden="true">→</span>
              </button>
            </div>
          </form>
        </div>

        <style>{`
          .draft-plan-form {
            width: 100%;
            /*max-width: 680px;*/
            margin: 8px auto 0;
          }

          .draft-plan-card {
            box-sizing: border-box;
            width: 100%;
            padding: 24px;
            background: #fff;
            border: 1px solid #e5e7eb;
            border-radius: 14px;
            box-shadow: 0 4px 14px rgba(15, 23, 42, 0.04);
          }

          .draft-plan-field {
            display: block;
            box-sizing: border-box;
            width: 100%;
            min-width: 0;
            margin: 0 0 22px;
            padding: 0;
            border: 0;
          }

          .draft-plan-label {
            display: block;
            margin: 0 0 9px;
            color: #374151;
            font-size: 14px;
            font-weight: 600;
          }

          .draft-plan-month {
            box-sizing: border-box;
            display: block;
            width: 100%;
            height: 46px;
            padding: 0 14px;
            border: 1px solid #d1d5db;
            border-radius: 9px;
            background: #fff;
            color: #111827;
            font: inherit;
            font-size: 14px !important;
          }

          .draft-plan-month:focus-visible {
            outline: 2px solid #9ca3af;
            outline-offset: 2px;
          }

          .draft-plan-types {
            display: flex;
            flex-direction: column;
            gap: 10px;
          }

          .draft-plan-types legend {
            float: none;
            width: 100%;
            margin-bottom: 10px;
          }

          .draft-plan-option {
            box-sizing: border-box;
            display: flex;
            align-items: center;
            gap: 12px;
            width: 100%;
            min-height: 62px;
            margin: 0;
            padding: 10px 13px;
            border: 1px solid #e5e7eb;
            border-radius: 10px;
            background: #fff;
            cursor: pointer;
            transition: border-color 150ms ease,
                        background-color 150ms ease;
          }

          .draft-plan-option:has(input:checked) {
            border-color: #111827;
            background: #f9fafb;
            min-height: 20px !important;
          }

          .draft-plan-option input[type="radio"] {
            appearance: none !important;
            -webkit-appearance: none !important;
            box-sizing: border-box;
            display: grid !important;
            place-content: center;
            flex: 0 0 20px;
            width: 20px !important;
            height: 20px !important;
            min-width: 20px !important;
            min-height: 20px !important;
            margin: 0 !important;
            padding: 0 !important;
            border: 1.5px solid #9ca3af !important;
            border-radius: 50% !important;
            background: #fff !important;
            box-shadow: none !important;
            cursor: pointer;
          }

          .draft-plan-option input[type="radio"]::before {
            content: "";
            width: 9px !important;
            height: 9px !important;
            border-radius: 50%;
            background: #fff;
            transform: scale(0);
          }

          .draft-plan-option input[type="radio"]:checked {
            border-color: #111827 !important;
            background: #111827 !important;
          }

          .draft-plan-option input[type="radio"]:checked::before {
            transform: scale(1);
          }

          .draft-plan-option input[type="radio"]:focus-visible {
            outline: 3px solid #d1d5db;
            outline-offset: 3px;
          }

          .draft-plan-option-content {
            display: flex;
            flex-direction: column;
            gap: 4px;
            min-width: 0;
          }

          .draft-plan-option-content strong {
            color: #111827;
            font-size: 14px;
            font-weight: 600;
          }

          .draft-plan-option-content small {
            color: #6b7280;
            font-size: 12px;
            line-height: 1.4;
          }

          .draft-plan-actions {
            display: flex;
            align-items: center;
            justify-content: flex-end;
            gap: 12px;
            margin-top: 28px;
          }

          .draft-plan-cancel,
          .draft-plan-continue {
            box-sizing: border-box;
            display: inline-flex;
            align-items: center;
            justify-content: center;
            gap: 8px;
            min-height: 42px;
            padding: 0 18px;
            border-radius: 9px;
            font-size: 14px;
            font-weight: 600;
            text-decoration: none;
            cursor: pointer;
          }

          .draft-plan-cancel {
            border: 1px solid #d1d5db;
            background: #fff;
            color: #374151;
          }

          .draft-plan-cancel:hover {
            background: #f9fafb;
          }

          .draft-plan-continue {
            min-width: 145px;
            border: 1px solid #111827;
            background: #111827;
            color: #fff;
            transition: background-color 150ms ease;
          }

          .draft-plan-continue:hover {
            background: #292f3a;
          }

          .draft-plan-cancel:focus-visible,
          .draft-plan-continue:focus-visible {
            outline: 3px solid #d1d5db;
            outline-offset: 3px;
          }

          @media (max-width: 600px) {
            .draft-plan-form {
              max-width: none;
            }

            .draft-plan-card {
              padding: 18px 14px;
            }

            .draft-plan-actions {
              gap: 8px;
            }

            .draft-plan-cancel {
              flex: 1;
            }

            .draft-plan-continue {
              flex: 1.5;
              min-width: 0;
            }
          }
        `}</style>
      </FormLayout>
    );
  }


  // No month or track asked for: the landing view is the month board.
  if (!params.month && !requested) {
    const rules = await loadAnalyticsRules();

    const board = await loadBuyingPlanBoard(
      Math.min(
        28,
        Math.max(
          1,
          Math.round(rules.plan_approval_deadline_day ?? 7)
        )
      )
    );

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
              <Link
                className="wf-btn wf-btn-primary wf-btn-sm"
                href="/buying-plan?mode=draft"
              >
                Create a Plan
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
  // A month that is over opens with its Variation Report: approved plan vs POs issued.
  const variation = isPlanFrozen(planMonth) ? await buyingPlanVariation(planMonth) : null;
  return (
    <BuyingPlanClient
      planMonth={planMonth}
      planMonths={planMonths}
      // NPD budget shows only when a cap exists (the "not set" banner was dropped, 2026-10-08);
      // on a month that is over it is read-only. It sits under the header.
      afterHeader={
        <>
          {variation && <VariationReportPanel report={variation} />}
          {npdBudget.cap != null ? <NpdBudgetCard budget={npdBudget} role={isPlanFrozen(planMonth) ? 'viewer' : role} /> : null}
        </>
      }
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
  const variation = isPlanFrozen(planMonth) ? materialPlanVariation(planMonth, lines) : null;
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
      afterHeader={variation ? <VariationReportPanel report={variation} /> : null}
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
