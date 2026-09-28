import 'server-only';
import { client, pageAll } from './_shared';
import type { IssuedPo, PoAmendment } from '../types';

const num = (v: unknown) => (v == null || v === '' ? null : Number(v));

/**
 * The issued POs an amendment can be raised against: every open EasyEcom PO, one row
 * each, aggregated by the database (sd_issued_pos) rather than paged as 26,000 lines.
 * Newest first. Paged all the same — the function returns a table and PostgREST caps
 * any response at 1,000 rows, function or not.
 */
export async function loadIssuedPos(): Promise<IssuedPo[]> {
  const supabase = await client();
  const rows = await pageAll<Record<string, unknown>>(() => supabase.rpc('sd_issued_pos'));
  return rows.map((r) => ({
    po_ref_num: String(r.po_ref_num ?? ''),
    po_number: (r.po_number as string | null) ?? null,
    vendor_code: (r.vendor_code as string | null) ?? null,
    vendor_name: (r.vendor_name as string | null) ?? null,
    po_status: (r.po_status as string | null) ?? null,
    product_codes: (r.product_codes as string | null) ?? null,
    lines: Number(r.lines) || 0,
    ordered_qty: Number(r.ordered_qty) || 0,
    pending_qty: Number(r.pending_qty) || 0,
    rate: num(r.rate),
    po_date: (r.po_date as string | null) ?? null,
    expected_delivery_date: (r.expected_delivery_date as string | null) ?? null,
  }));
}

/** Every amendment raised, newest first, for the PO Amendment page. */
export async function loadPoAmendments(): Promise<PoAmendment[]> {
  const supabase = await client();
  const { data } = await supabase
    .from('sd_po_amendment')
    .select('*')
    .order('id', { ascending: false })
    .limit(500);
  return ((data ?? []) as PoAmendment[]).map((a) => ({
    ...a,
    current_rate: num(a.current_rate),
    new_rate: num(a.new_rate),
    current_qty: num(a.current_qty),
    new_qty: num(a.new_qty),
  }));
}
