import { redirect } from 'next/navigation';
import { FormLayout, Notice } from '@/components/forms/form-layout';
import { currentUser, NotConfiguredError } from '@/lib/forms/queries';
import { ALL_VIEWS } from '@/lib/views';
import { loadFeatureStatuses } from '@/lib/feature-status.server';
import { FeatureStatusClient, type FeatureRow } from './feature-status-client';

export const dynamic = 'force-dynamic';

export default async function FeatureStatusPage() {
  let user;
  try {
    user = await currentUser();
  } catch (error) {
    if (error instanceof NotConfiguredError) {
      return (
        <FormLayout title="Feature Status" active="/feature-status" role="viewer">
          <Notice tone="error">{error.message}</Notice>
        </FormLayout>
      );
    }
    throw error;
  }

  if (!user) redirect('/login');
  if (user.role !== 'admin') redirect('/');

  const statuses = await loadFeatureStatuses();
  const rows: FeatureRow[] = ALL_VIEWS.map((v) => ({
    key: v.path,
    label: v.label,
    group: v.group,
    status: statuses[v.path]?.status ?? 'live',
    note: statuses[v.path]?.note ?? '',
  }));

  return (
    <FormLayout
      title="Feature Status"
      subtitle="Label each feature's sprint phase — Live, In Testing, or Coming Soon — so the team knows what's ready to trust. Shows as a badge on the feature's page header. Editable here without a code change; pairs with the hide-non-released rule (fully hidden vs. visible-but-labelled)."
      active="/feature-status"
      role={user.role}
      userEmail={user.email}
      allowedPages={user.allowed_pages ?? null}
      accent="orange"
    >
      <FeatureStatusClient rows={rows} />
    </FormLayout>
  );
}
