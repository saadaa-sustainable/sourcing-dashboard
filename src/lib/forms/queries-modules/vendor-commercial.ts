import 'server-only';
import { client, pageAll } from './_shared';
import type { VendorCommercialRequest } from '../types';

/**
 * Everything the Vendor Commercial Approval page needs: every request (newest first) and the
 * vendor master for the picker (code + firm name; a fabric supplier not in the master can still
 * be typed in).
 *   ready: false — the table does not exist yet (migration 20261009180000 not applied)
 */
export async function loadVendorCommercial(): Promise<{
  ready: boolean;
  requests: VendorCommercialRequest[];
  vendors: { vendor_code: string; vendor_name: string | null; primary_type: string | null }[];
}> {
  const supabase = await client();
  const [reqs, vendors] = await Promise.all([
    pageAll<VendorCommercialRequest>(() =>
      supabase.from('sd_vendor_commercial_request' as never).select('*').order('id', { ascending: false }),
    ).then(
      (rows) => ({ rows, ready: true }),
      () => ({ rows: [] as VendorCommercialRequest[], ready: false }),
    ),
    pageAll<{ vendor_code: string | null; vendor_name: string | null; primary_type: string | null }>(() =>
      supabase.from('vendor_master_data').select('vendor_code, vendor_name, primary_type').order('vendor_code'),
    ).catch(() => []),
  ]);
  const ready = reqs.ready;
  const requests = reqs.rows.map((r) => ({
    ...r,
    attachments: Array.isArray(r.attachments) ? r.attachments : [],
    hold_qty: r.hold_qty == null ? null : Number(r.hold_qty),
    increment_amount: r.increment_amount == null ? null : Number(r.increment_amount),
    invoice_amount: r.invoice_amount == null ? null : Number(r.invoice_amount),
    credit_amount: r.credit_amount == null ? null : Number(r.credit_amount),
  }));
  return {
    ready,
    requests,
    vendors: vendors
      .filter((v) => (v.vendor_code ?? '').trim())
      .map((v) => ({ vendor_code: (v.vendor_code as string).trim().toUpperCase(), vendor_name: v.vendor_name, primary_type: v.primary_type })),
  };
}
