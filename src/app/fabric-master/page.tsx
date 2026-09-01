import { redirect } from 'next/navigation';
import { FormLayout, Notice } from '@/components/forms/form-layout';
import {
  currentUser,
  loadFabricMaster,
  NotConfiguredError,
} from '@/lib/forms/queries';
import { canEdit } from '@/lib/forms/approval';
import { FabricMasterClient } from './fabric-master-client';

export const dynamic = 'force-dynamic';

export default async function FabricMasterPage() {
  let user;
  try {
    user = await currentUser();
  } catch (error) {
    if (error instanceof NotConfiguredError) {
      return (
        <FormLayout title="Fabric Master" active="/fabric-master" role="viewer">
          <Notice tone="error">{error.message}</Notice>
        </FormLayout>
      );
    }
    throw error;
  }

  if (!user) redirect('/login');

  const fabrics = await loadFabricMaster();

  return (
    <FormLayout
      title="Fabric Master"
      subtitle="Fabric composition codes with duplicate prevention — the source the Buying Plan material track picks from."
      active="/fabric-master"
      role={user.role}
      userEmail={user.email}
      allowedPages={user.allowed_pages ?? null}
    >
      <FabricMasterClient fabrics={fabrics} editable={canEdit(user.role, 'draft')} />
    </FormLayout>
  );
}
