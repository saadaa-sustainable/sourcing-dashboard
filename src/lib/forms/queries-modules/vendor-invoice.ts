import 'server-only';
import { client, pageAll } from './_shared';
import type { VendorInvoice } from '@/lib/vendor-invoice';

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
