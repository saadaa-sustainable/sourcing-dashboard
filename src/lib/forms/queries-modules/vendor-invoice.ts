import 'server-only';
import { client, pageAll } from './_shared';
import type { VendorInvoice, VendorViewLink } from '@/lib/vendor-invoice';

/** Every vendor invoice / debit note / credit note entry, newest first. */
export async function loadVendorInvoices(): Promise<VendorInvoice[]> {
  const supabase = await client();
  return pageAll<VendorInvoice>(() =>
    supabase
      .from('sd_vendor_invoice')
      .select('*')
      .order('created_at', { ascending: false })
      .order('id', { ascending: false }),
  );
}

/** Vendor code -> name from the EasyEcom vendor master, to label the form's codes. */
export async function loadVendorNames(): Promise<Record<string, string>> {
  const supabase = await client();
  const rows = await pageAll<{ vendor_code: string; vendor_name: string | null }>(() =>
    supabase.from('sd_ee_vendor_master').select('vendor_code, vendor_name').order('vendor_code'),
  );
  return Object.fromEntries(rows.map((r) => [r.vendor_code.toUpperCase(), (r.vendor_name ?? '').trim()]));
}

/** Per-vendor view links, newest first (revoked ones included, for the record). */
export async function loadVendorViewLinks(): Promise<VendorViewLink[]> {
  const supabase = await client();
  try {
    return await pageAll<VendorViewLink>(() =>
      supabase
        .from('sd_vendor_view_link')
        .select('id, token, vendor_code, created_by, created_at, revoked_at, last_seen_at')
        .order('created_at', { ascending: false })
        .order('id', { ascending: false }),
    );
  } catch (error) {
    // Until migration 20261006140000 is applied the table does not exist; the rest of the
    // page still works. Any other failure stays loud.
    if (/sd_vendor_view_link/.test(String((error as Error)?.message)) && /schema cache|does not exist/i.test(String((error as Error)?.message)))
      return [];
    throw error;
  }
}
