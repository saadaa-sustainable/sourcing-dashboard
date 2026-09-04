import { redirect } from 'next/navigation';
import { FormLayout, Notice } from '@/components/forms/form-layout';
import { currentUser, NotConfiguredError } from '@/lib/forms/queries';
import { canEdit } from '@/lib/forms/approval';
import { loadCategoryMapState } from '@/lib/category-mapping.server';
import { CategoryMappingClient } from './category-mapping-client';

export const dynamic = 'force-dynamic';

export default async function CategoryMappingPage() {
  let user;
  try {
    user = await currentUser();
  } catch (error) {
    if (error instanceof NotConfiguredError) {
      return (
        <FormLayout title="Category Mapping" active="/category-mapping" role="viewer">
          <Notice tone="error">{error.message}</Notice>
        </FormLayout>
      );
    }
    throw error;
  }

  if (!user) redirect('/login');

  const state = await loadCategoryMapState();

  return (
    <FormLayout
      title="Category Mapping"
      subtitle="The authoritative category / sub-category per product code — mandatory, and the one field every zoomed-out view (Buying Plan snapshot, Group By, Cost Analytics) slices by."
      active="/category-mapping"
      role={user.role}
      userEmail={user.email}
      allowedPages={user.allowed_pages ?? null}
      accent="teal"
    >
      <CategoryMappingClient
        rows={state.rows}
        missingCount={state.missingCount}
        categoryOptions={state.categoryOptions}
        subCategoryOptions={state.subCategoryOptions}
        editable={canEdit(user.role, 'draft')}
      />
    </FormLayout>
  );
}
