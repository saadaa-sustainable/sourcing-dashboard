import 'server-only';
import { createAdminClient, hasSupabaseAdminEnv } from '@/lib/supabase/admin';
import { pageAll } from '@/lib/forms/queries-modules/_shared';
import type { VendorInvoice } from '@/lib/vendor-invoice';

/**
 * The vendor's own view behind /vendor-invoice/view/<token> (schema row "PENDING AND FILLED
 * INV VIEW", VIEW TO VENDOR). Vendors have no login, so this reads with the service-role
 * client and scopes every read to the one vendor code the token belongs to.
 *
 * Filled  = invoice / debit note / credit note entries for this vendor: entries carrying its
 *           vendor code, plus code-less entries (dyeing / fabric-supply partners are not asked
 *           for a code) whose PO is one of its POs.
 * Pending = a PO of this vendor with goods received (EasyEcom GRN) on or after VI_PENDING_FROM
 *           whose received qty is more than the qty on the invoices uploaded for it.
 */

/** Invoice upload moved to the dashboard on this day. Earlier receipts were invoiced through
 *  the Google Form, whose responses are not on the dashboard, so they are not called pending. */
export const VI_PENDING_FROM = '2026-10-06';

export type ViPendingPo = {
  po: string;
  po_number: string | null;
  grn_ids: number[];
  first_grn: string;
  last_grn: string;
  received: number;
  invoiced: number;
};

export type VendorView = {
  linkId: number;
  vendorCode: string;
  vendorName: string | null;
  entries: VendorInvoice[];
  pending: ViPendingPo[];
};

const key = (s: string | null | undefined) => String(s ?? '').trim().toUpperCase();

export async function resolveViewToken(token: string): Promise<{ id: number; vendor_code: string } | null> {
  if (!hasSupabaseAdminEnv() || !/^[A-Za-z0-9_-]{20,64}$/.test(token)) return null;
  const { data } = await createAdminClient()
    .from('sd_vendor_view_link')
    .select('id, vendor_code')
    .eq('token', token)
    .is('revoked_at', null)
    .maybeSingle();
  return (data as { id: number; vendor_code: string } | null) ?? null;
}

export async function loadVendorView(token: string): Promise<VendorView | null> {
  const link = await resolveViewToken(token);
  if (!link) return null;
  const admin = createAdminClient();
  const code = key(link.vendor_code);

  // Best effort: when the vendor last opened their page (shown on the team's link list).
  void admin.from('sd_vendor_view_link').update({ last_seen_at: new Date().toISOString() }).eq('id', link.id).then(
    () => undefined,
    () => undefined,
  );

  const [vendorRows, poRows, ownEntries, codelessEntries] = await Promise.all([
    // paging-ok: one vendor code, a single master row
    admin.from('sd_ee_vendor_master').select('vendor_name, vendor_c_id').eq('vendor_code', code).limit(1),
    pageAll<{ po_id: number; po_number: string | null; po_ref_num: string | null }>(() =>
      admin.from('sd_po_master_raw').select('po_id, po_number, po_ref_num').eq('vendor_code', code).order('po_detail_id'),
    ),
    pageAll<VendorInvoice>(() =>
      admin.from('sd_vendor_invoice').select('*').eq('vendor_code', code).order('id', { ascending: false }),
    ),
    pageAll<VendorInvoice>(() =>
      admin.from('sd_vendor_invoice').select('*').is('vendor_code', null).order('id', { ascending: false }),
    ),
  ]);

  const vendor = (vendorRows.data?.[0] ?? null) as { vendor_name: string | null; vendor_c_id: string | number | null } | null;

  // This vendor's POs, by id and by both ways a vendor may write the number.
  const poKeys = new Set<string>();
  const refById = new Map<number, { ref: string; num: string | null }>();
  for (const r of poRows) {
    if (r.po_ref_num) poKeys.add(key(r.po_ref_num));
    if (r.po_number) poKeys.add(key(r.po_number));
    if (!refById.has(r.po_id)) refById.set(r.po_id, { ref: r.po_ref_num || r.po_number || String(r.po_id), num: r.po_number });
  }

  const entries = [...ownEntries, ...codelessEntries.filter((e) => poKeys.has(key(e.po_ref_num)))].sort(
    (a, b) => b.created_at.localeCompare(a.created_at) || b.id - a.id,
  );

  // Receipts since the cut-over, for this vendor's POs.
  const grns =
    vendor?.vendor_c_id != null
      ? await pageAll<{ grn_detail_id: number; grn_id: number; po_id: number; grn_created_at: string; received_quantity: number | null }>(() =>
          admin
            .from('sd_ee_grn')
            .select('grn_detail_id, grn_id, po_id, grn_created_at, received_quantity')
            .eq('vendor_c_id', Number(vendor.vendor_c_id))
            .gte('grn_created_at', VI_PENDING_FROM)
            .order('grn_created_at')
            .order('grn_detail_id'),
        )
      : [];

  const byPo = new Map<number, ViPendingPo>();
  for (const g of grns) {
    const po = refById.get(g.po_id) ?? { ref: String(g.po_id), num: null };
    let row = byPo.get(g.po_id);
    if (!row) {
      row = { po: po.ref, po_number: po.num, grn_ids: [], first_grn: g.grn_created_at, last_grn: g.grn_created_at, received: 0, invoiced: 0 };
      byPo.set(g.po_id, row);
    }
    if (!row.grn_ids.includes(g.grn_id)) row.grn_ids.push(g.grn_id);
    if (g.grn_created_at < row.first_grn) row.first_grn = g.grn_created_at;
    if (g.grn_created_at > row.last_grn) row.last_grn = g.grn_created_at;
    row.received += Number(g.received_quantity ?? 0);
  }

  // Invoiced qty per PO, matched on either form of the PO number.
  const invoicedByKey = new Map<string, number>();
  for (const e of entries) {
    if (e.document_type !== 'INVOICE') continue;
    const k = key(e.po_ref_num);
    invoicedByKey.set(k, (invoicedByKey.get(k) ?? 0) + Number(e.invoice_total_qty ?? 0));
  }
  const pending: ViPendingPo[] = [];
  for (const row of byPo.values()) {
    row.invoiced = (invoicedByKey.get(key(row.po)) ?? 0) + (row.po_number && key(row.po_number) !== key(row.po) ? invoicedByKey.get(key(row.po_number)) ?? 0 : 0);
    if (row.received > row.invoiced) pending.push(row);
  }
  pending.sort((a, b) => a.first_grn.localeCompare(b.first_grn));

  return {
    linkId: link.id,
    vendorCode: code,
    vendorName: vendor?.vendor_name?.trim() || null,
    entries,
    pending,
  };
}
