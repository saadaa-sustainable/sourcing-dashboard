import { redirect } from 'next/navigation';
import { FormLayout, Notice } from '@/components/forms/form-layout';
import { currentUser, NotConfiguredError } from '@/lib/forms/queries';
import { loadProductHub } from '@/lib/product-hub.server';
import { Product360Client } from './product-360-client';

export const dynamic = 'force-dynamic';

export default async function Product360Page() {
  let user;
  try {
    user = await currentUser();
  } catch (error) {
    if (error instanceof NotConfiguredError) {
      return (
        <FormLayout title="Product 360" active="/product-360" role="viewer">
          <Notice tone="error">{error.message}</Notice>
        </FormLayout>
      );
    }
    throw error;
  }

  if (!user) redirect('/login');

  const data = await loadProductHub();

  return (
    <FormLayout
      title="Product 360"
      subtitle="One objective, one dimension — every product's availability (stockout + OOS), replenishment need and lifecycle (discontinued still on open POs) in a single one-pager (the DAM principle), instead of piecing it together across separate cards."
      active="/product-360"
      role={user.role}
      userEmail={user.email}
      allowedPages={user.allowed_pages ?? null}
      accent="teal"
    >
      <Product360Client data={data} />
    </FormLayout>
  );
}
