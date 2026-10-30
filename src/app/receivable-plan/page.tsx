
import Link from 'next/link';
import { redirect } from 'next/navigation';
import { FormLayout, Notice } from '@/components/forms/form-layout';
import {
  currentUser,
  loadArrivalPlan,
  loadInwardPlanSheet,
  loadInwardPlanBoard,
  inwardPlanMonthOptions,
  loadReceivablePlan,
  NotConfiguredError,
} from '@/lib/forms/queries';
import { canEdit, monthStart, weekStart } from '@/lib/forms/approval';
import { inwardPlanVariation } from '@/lib/forms/queries-modules/variation-reports';
import { VariationReportPanel } from '@/components/variation-report';
import { ReceivablePlanClient } from './receivable-plan-client';
import { MonthBoard } from '@/components/month-board';

// The current receiving week (Mon–Sun), computed server-side.
function weekRange() {
  const start = weekStart();
  const end = new Date(`${start}T00:00:00Z`);
  end.setUTCDate(end.getUTCDate() + 6);
  return {
    weekStart: start,
    weekEnd: end.toISOString().slice(0, 10),
  };
}

// Today's date in India.
function todayIst() {
  return new Date(Date.now() + 330 * 60_000)
    .toISOString()
    .slice(0, 10);
}

// Twelve planning months, beginning with the current month.
function planningMonthOptions() {
  const start = new Date(`${monthStart()}T00:00:00Z`);

  return Array.from({ length: 12 }, (_, index) => {
    const date = new Date(start);
    date.setUTCMonth(date.getUTCMonth() + index);

    return {
      value: date.toISOString().slice(0, 10),
      label: date.toLocaleDateString('en-IN', {
        month: 'long',
        year: 'numeric',
        timeZone: 'UTC',
      }),
    };
  });
}

export const dynamic = 'force-dynamic';

export default async function ReceivablePlanPage({
  searchParams,
}: {
  searchParams: Promise<{
    tab?: string;
    month?: string;
    type?: string;
  }>;
}) {
  const params = await searchParams;

  let user;

  try {
    user = await currentUser();
  } catch (error) {
    if (error instanceof NotConfiguredError) {
      return (
        <FormLayout
          title="Inward Plan"
          active="/receivable-plan"
          role="viewer"
        >
          <Notice tone="error">{error.message}</Notice>
        </FormLayout>
      );
    }

    throw error;
  }

  if (!user) redirect('/login');

  const editable = canEdit(user.role, 'draft');

  // Step 1: Create Inward Plan — choose month and plan type.
  if (params.tab === 'create') {
    const months = planningMonthOptions();

    return (
      <FormLayout
        title="Create Inward Plan"
        subtitle="Choose the planning month and the type of inward plan you want to create."
        active="/receivable-plan"
        role={user.role}
        userEmail={user.email}
        allowedPages={user.allowed_pages ?? null}
      >
        <Link className="mb-back" href="/receivable-plan">
          ← All months
        </Link>

        <div className="wf-card" style={{ maxWidth: 680, padding: 24 }}>
          <form action="/receivable-plan" method="get">
            <input type="hidden" name="tab" value="input" />
            <input type="hidden" name="type" value="fg" />

            <div style={{ marginBottom: 24 }}>
              <label
                htmlFor="planning-month"
                style={{
                  display: 'block',
                  fontWeight: 600,
                  marginBottom: 8,
                }}
              >
                Planning Month
              </label>

              <select
                id="planning-month"
                name="month"
                defaultValue={monthStart()}
                required
                className="wf-input"
                style={{ width: '100%', minHeight: 42 }}
              >
                {months.map((month) => (
                  <option key={month.value} value={month.value}>
                    {month.label}
                  </option>
                ))}
              </select>
            </div>

            <fieldset
              style={{
                border: 0,
                padding: 0,
                margin: '0 0 24px',
              }}
            >
              <legend
                style={{
                  fontWeight: 600,
                  marginBottom: 12,
                }}
              >
                Plan Type
              </legend>

              <label
                style={{
                  display: 'flex',
                  alignItems: 'flex-start',
                  gap: 12,
                  padding: 16,
                  border: '1px solid var(--border, #d1d5db)',
                  borderRadius: 10,
                  marginBottom: 10,
                  cursor: 'pointer',
                }}
              >
                <input
                  type="radio"
                  name="plan-type-display"
                  value="fg"
                  defaultChecked
                  style={{ marginTop: 4 }}
                />

                <span>
                  <strong>Finished Goods</strong>
                  <span
                    style={{
                      display: 'block',
                      fontSize: 13,
                      opacity: 0.75,
                      marginTop: 4,
                    }}
                  >
                    Plan expected receipts against finished-goods PO lines.
                  </span>
                </span>
              </label>

              <label
                aria-disabled="true"
                style={{
                  display: 'flex',
                  alignItems: 'flex-start',
                  gap: 12,
                  padding: 16,
                  border: '1px solid var(--border, #d1d5db)',
                  borderRadius: 10,
                  opacity: 0.55,
                  cursor: 'not-allowed',
                }}
              >
                <input
                  type="radio"
                  disabled
                  name="plan-type-display"
                  value="material"
                  style={{ marginTop: 4 }}
                />

                <span>
                  <strong>Fabric / Material</strong>
                  <span
                    style={{
                      display: 'block',
                      fontSize: 13,
                      marginTop: 4,
                    }}
                  >
                    Coming soon — this workflow is not available yet.
                  </span>
                </span>
              </label>
            </fieldset>

            <div
              style={{
                display: 'flex',
                justifyContent: 'flex-end',
                gap: 12,
              }}
            >
              <Link
                className="wf-btn wf-btn-secondary"
                href="/receivable-plan"
              >
                Cancel
              </Link>

              <button
                className="wf-btn wf-btn-primary"
                type="submit"
                disabled={!editable}
              >
                Continue →
              </button>
            </div>

            {!editable && (
              <p
                style={{
                  fontSize: 13,
                  marginTop: 12,
                  opacity: 0.75,
                }}
              >
                You have view-only access to Inward Plan creation.
              </p>
            )}
          </form>
        </div>
      </FormLayout>
    );
  }

  // Landing view: one card per plan month.
  if (!params.tab && !params.month) {
    const board = await loadInwardPlanBoard();

    return (
      <FormLayout
        title="Inward Plan"
        subtitle="Every month's inward plan by where its lines stand: waiting for approval, sent back, approved or closed. Open a month to see its lines."
        active="/receivable-plan"
        role={user.role}
        userEmail={user.email}
        allowedPages={user.allowed_pages ?? null}
      >
        <MonthBoard
          data={board}
          pageBar={
            editable ? (
              <Link
                className="wf-btn wf-btn-primary wf-btn-sm"
                href="/receivable-plan?tab=create"
              >
                Create Inward Plan
              </Link>
            ) : null
          }
        />
      </FormLayout>
    );
  }

  // Existing FG input and viewing workflow remains unchanged.
  const initialTab =
    params.tab === 'monthly' ||
    params.tab === 'input' ||
    params.tab === 'lines'
      ? params.tab
      : 'arrivals';

  const isInput = initialTab === 'input';

  const [rows, arrivals, sheet] = await Promise.all([
    loadReceivablePlan(),
    isInput ? Promise.resolve({ rows: [] }) : loadArrivalPlan(),
    isInput ? Promise.resolve([]) : loadInwardPlanSheet(),
  ]);

  const week = weekRange();

  const initialMonth = /^\d{4}-\d{2}-01$/.test(params.month ?? '')
    ? params.month!
    : null;

  // A past month opens with its variation report.
  const variation =
    !isInput && initialMonth && initialMonth < monthStart()
      ? inwardPlanVariation(initialMonth, sheet)
      : null;

  return (
    <FormLayout
      title="Inward Plan"
      subtitle={
        isInput
          ? 'Enter the quantity and receiving week or month per PO line, then submit for approval.'
          : 'What is arriving and when: arrivals against the plan, the monthly sheet and the plan lines. Read-only — enter changes on Input inward plan.'
      }
      active="/receivable-plan"
      role={user.role}
      userEmail={user.email}
      allowedPages={user.allowed_pages ?? null}
    >
      <Link className="mb-back" href="/receivable-plan">
        ← All months
      </Link>

      {variation && <VariationReportPanel report={variation} />}

      <ReceivablePlanClient
        key={`${initialTab}|${initialMonth ?? ''}`}
        rows={rows}
        arrivals={arrivals.rows}
        editable={editable}
        weekStart={week.weekStart}
        weekEnd={week.weekEnd}
        sheet={sheet}
        sheetMonths={inwardPlanMonthOptions(sheet)}
        role={user.role}
        initialTab={initialTab}
        initialMonth={initialMonth}
        today={todayIst()}
      />
    </FormLayout>
  );
}