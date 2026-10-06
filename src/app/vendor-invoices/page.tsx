import { redirect } from 'next/navigation';
import { FormLayout, Notice } from '@/components/forms/form-layout';
import { currentUser, loadVendorInvoices, loadVendorNames, NotConfiguredError } from '@/lib/forms/queries';
import { VendorInvoicesClient } from './vendor-invoices-client';

export const dynamic = 'force-dynamic';

export default async function VendorInvoicesPage() {
  let user;
  try {
    user = await currentUser();
  } catch (error) {
    if (error instanceof NotConfiguredError) {
      return (
        <FormLayout title="Vendor Invoices" active="/vendor-invoices" role="viewer">
          <Notice tone="error">{error.message}</Notice>
        </FormLayout>
      );
    }
    throw error;
  }
  if (!user) redirect('/login');

  const [entries, names] = await Promise.all([loadVendorInvoices(), loadVendorNames()]);

  return (
    <FormLayout
      title="Vendor Invoices"
      subtitle="Soft copies of vendor invoices, debit notes and credit notes. Vendors submit them through one open link, which replaces the Vendor Invoices - Accounts Google Form."
      active="/vendor-invoices"
      role={user.role}
      userEmail={user.email}
      allowedPages={user.allowed_pages ?? null}
      accent="orange"
    >
      <VendorInvoicesClient entries={entries} vendorNames={names} isAdmin={user.role === 'admin'} />
    </FormLayout>
  );
}
