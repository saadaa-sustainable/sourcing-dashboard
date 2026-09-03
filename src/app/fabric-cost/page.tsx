import { redirect } from 'next/navigation';
import { FormLayout, Notice } from '@/components/forms/form-layout';
import {
  currentUser,
  loadFabricCostBase,
  NotConfiguredError,
} from '@/lib/forms/queries';
import { canEdit } from '@/lib/forms/approval';
import { FabricCostClient } from './fabric-cost-client';
import { FabricRateSubmissionPanel } from '@/components/forms/fabric-rate-submission-panel';
import { loadFabricRateSubmissionState } from '@/lib/fabric-rate-submission.server';

export const dynamic = 'force-dynamic';

export default async function FabricCostPage() {
  let user;
  try {
    user = await currentUser();
  } catch (error) {
    if (error instanceof NotConfiguredError) {
      return (
        <FormLayout title="Fabric Cost" active="/fabric-cost" role="viewer">
          <Notice tone="error">{error.message}</Notice>
        </FormLayout>
      );
    }
    throw error;
  }

  if (!user) redirect('/login');

  const [rows, submissionState] = await Promise.all([
    loadFabricCostBase(),
    loadFabricRateSubmissionState(),
  ]);
  const editable = canEdit(user.role, 'draft');

  return (
    <FormLayout
      title="Fabric Cost"
      subtitle="Fabric cost base sheet — grey rate, processing and finished fabric cost, plus the one-time yarn → grey conversion."
      active="/fabric-cost"
      role={user.role}
      userEmail={user.email}
      allowedPages={user.allowed_pages ?? null}
      accent="teal"
    >
      {/* Item 5 — mandatory monthly rate submission (per fabric). */}
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
    </FormLayout>
  );
}
