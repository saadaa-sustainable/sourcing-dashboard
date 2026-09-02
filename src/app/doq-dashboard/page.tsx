import { redirect } from 'next/navigation';
import { FormLayout, Notice } from '@/components/forms/form-layout';
import {
  currentUser,
  loadDoqWindowMeta,
  loadDoqWindows,
  loadOosCalculation,
  loadOosExclusions,
  NotConfiguredError,
} from '@/lib/forms/queries';
import { canView } from '@/lib/views';
import {
  aggregateDoqWindow,
  DOQ_WEAVES,
  DOQ_WINDOW_KEYS,
  type DoqCategoryRow,
  type DoqWeave,
  type DoqWindowKey,
} from '@/lib/doq-dashboard';
import { DoqDashboardClient } from './doq-dashboard-client';

export const dynamic = 'force-dynamic';

export default async function DoqDashboardPage() {
  let user;
  try {
    user = await currentUser();
  } catch (error) {
    if (error instanceof NotConfiguredError) {
      return (
        <FormLayout title="DOQ Dashboard" active="/doq-dashboard" role="viewer">
          <Notice tone="error">{error.message}</Notice>
        </FormLayout>
      );
    }
    throw error;
  }

  if (!user) redirect('/login');
  if (!canView('/doq-dashboard', user.role, user.allowed_pages ?? null)) redirect('/');

  const [windows, meta, oosMeta, exclusions] = await Promise.all([
    loadDoqWindows(),
    loadDoqWindowMeta(),
    loadOosCalculation(),
    loadOosExclusions(),
  ]);

  const excluded = new Set(exclusions.map((e) => e.sku.toUpperCase()));

  // Pre-aggregate every window × weave server-side; the client only switches.
  const tables = {} as Record<DoqWindowKey, Record<DoqWeave, DoqCategoryRow[]>>;
  for (const key of DOQ_WINDOW_KEYS) {
    tables[key] = {} as Record<DoqWeave, DoqCategoryRow[]>;
    for (const weave of DOQ_WEAVES) {
      tables[key][weave] = aggregateDoqWindow(
        windows,
        oosMeta,
        excluded,
        key,
        weave,
        meta?.windows?.[key]?.ndays ?? 1,
      );
    }
  }

  return (
    <FormLayout
      title="DOQ Dashboard"
      subtitle="The DOQ window view — daily demand rate, days-on-hand, OOS days and sales leakage by product state, over yesterday / weekly / 7-day / all-time windows. Ported formula-for-formula from the DOQ sheet."
      active="/doq-dashboard"
      role={user.role}
      userEmail={user.email}
      allowedPages={user.allowed_pages ?? null}
    >
      {!meta && (
        <Notice tone="warn">
          Window aggregates have not been synced yet — run bqSyncDoqWindows in
          the Apps Script project (or wait for the next 6 AM sync).
        </Notice>
      )}
      <DoqDashboardClient tables={tables} meta={meta} excludedCount={excluded.size} />
    </FormLayout>
  );
}
