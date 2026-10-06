import type { Metadata } from 'next';
import { createAdminClient, hasSupabaseAdminEnv } from '@/lib/supabase/admin';
import { VI_VENDOR_CODES } from '@/lib/vendor-invoice';
import { VendorInvoiceForm } from './vendor-invoice-form';

// Public, no-login replacement for the "Vendor Invoices - Accounts" Google Form. One open
// link for every vendor; entries land in sd_vendor_invoice and show on /vendor-invoices.
export const dynamic = 'force-dynamic';

export const metadata: Metadata = {
  title: 'Vendor Invoices - Accounts · SAADAA',
  robots: { index: false, follow: false },
};

/** Names for the form's vendor codes, so a vendor can find their own code. Best effort. */
async function vendorNames(): Promise<Record<string, string>> {
  if (!hasSupabaseAdminEnv()) return {};
  try {
    // paging-ok: filtered to the form's 31 vendor codes
    const { data } = await createAdminClient()
      .from('sd_ee_vendor_master')
      .select('vendor_code, vendor_name')
      .in('vendor_code', [...VI_VENDOR_CODES]);
    return Object.fromEntries(
      ((data ?? []) as { vendor_code: string; vendor_name: string | null }[]).map((r) => [
        r.vendor_code.toUpperCase(),
        (r.vendor_name ?? '').trim(),
      ]),
    );
  } catch {
    return {};
  }
}

export default async function VendorInvoicePage({ searchParams }: { searchParams: Promise<{ code?: string }> }) {
  const [names, { code }] = await Promise.all([vendorNames(), searchParams]);
  // A vendor arriving from their own invoices page lands with their code chosen.
  const upper = String(code ?? '').trim().toUpperCase();
  const initialCode = /^[A-Z0-9_-]{1,20}$/.test(upper) ? upper : '';
  return (
    <main className="fill-shell">
      <div className="fill-card vi-card">
        <div className="fill-brand">SAADAA</div>
        <h1>Vendor Invoices - Accounts</h1>
        <div className="vi-intro">
          <p>This form is to share soft copy of Invoices / Debit Notes / Credit Notes.</p>
          <p>Feel free to contact Saadaa&apos;s Accounts team - 9251634098</p>
          <p>
            Important note - This form has to be filled to share soft copy of accounts documents like - Invoice,
            Debit Note &amp; Credit note to Saadaa.
          </p>
          <p>
            <strong>
              Also, submit the hard copy of the uploaded invoice to the Merchandiser team / Warehouse / Saadaa
              Accounts.
            </strong>
          </p>
        </div>
        <VendorInvoiceForm vendorNames={names} initialCode={initialCode} />
      </div>
    </main>
  );
}
