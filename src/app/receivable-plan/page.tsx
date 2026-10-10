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

// The current receiving week (Mon–Sun), computed server-side so the client's
// "arriving this week" filter needs no clock of its own.
function weekRange() {
  const start = weekStart();
  const end = new Date(`${start}T00:00:00Z`);
  end.setUTCDate(end.getUTCDate() + 6);
  return { weekStart: start, weekEnd: end.toISOString().slice(0, 10) };
}

// Today's date in India, for the week board's "this week" and upcoming days.
function todayIst() {
  return new Date(Date.now() + 330 * 60_000).toISOString().slice(0, 10);
}

export const dynamic = 'force-dynamic';

export default async function ReceivablePlanPage({
  searchParams,
}: {
  searchParams: Promise<{ tab?: string; month?: string }>;
}) {
  const params = await searchParams;
  let user;
  try {
    user = await currentUser();
  } catch (error) {
    if (error instanceof NotConfiguredError) {
      return (
        <FormLayout title="Inward Plan" active="/receivable-plan" role="viewer">
          <Notice tone="error">{error.message}</Notice>
        </FormLayout>
      );
    }
    throw error;
  }

  if (!user) redirect('/login');

  // Landing view: one card per plan month, by where its lines stand.
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
            canEdit(user.role, 'draft') ? (
              <Link className="wf-btn wf-btn-primary wf-btn-sm" href="/receivable-plan?tab=input">Input inward plan</Link>
            ) : null
          }
        />
      </FormLayout>
    );
  }

  // Two screens: Input (?tab=input) enters the plan; View (arrivals / monthly / lines) reads it.
  // Input only needs the PO lines, so it skips the arrivals and monthly-sheet reads.
  const initialTab =
    params.tab === 'monthly' || params.tab === 'input' || params.tab === 'lines' ? params.tab : 'arrivals';
  const isInput = initialTab === 'input';
  const [rows, arrivals, sheet] = await Promise.all([
    loadReceivablePlan(),
    isInput ? Promise.resolve({ rows: [] }) : loadArrivalPlan(),
    isInput ? Promise.resolve([]) : loadInwardPlanSheet(),
  ]);
  const week = weekRange();
  const initialMonth = /^\d{4}-\d{2}-01$/.test(params.month ?? '') ? (params.month as string) : null;
  // A month that is over opens with its Variation Report: approved inward qty vs GRN received.
  const variation = !isInput && initialMonth && initialMonth < monthStart() ? inwardPlanVariation(initialMonth, sheet) : null;

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
      <Link className="mb-back" href="/receivable-plan">← All months</Link>
      {variation && <VariationReportPanel report={variation} />}
      {/* Keyed by the screen and tab in the URL: switching View ↔ Input through a link reuses this
          client otherwise, keeping the old tab with the other screen's data (Input does not load the sheet). */}
      <ReceivablePlanClient
        key={`${initialTab}|${initialMonth ?? ''}`}
        rows={rows}
        arrivals={arrivals.rows}
        editable={canEdit(user.role, 'draft')}
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
