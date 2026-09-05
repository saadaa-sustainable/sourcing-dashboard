import 'server-only';
import { client, PAGE_SIZE } from './_shared';
import { computeClosureCompliance } from '@/lib/business-logic';
import type { PoClosure, PoClosureView, PoSubmissionGroup, SdStatus } from '../types';

/**
 * PO closures with derived compliance. First syncs closure rows for recently-
 * completed POs (SECURITY DEFINER; the SLA clock starts at completion), then reads
 * and attaches the real-time RAG/SLA (computed, never stored).
 */
export async function loadPoClosures(): Promise<PoClosureView[]> {
  const supabase = await client();
  try {
    await supabase.rpc('sd_sync_po_closures');
  } catch {
    /* best-effort — a sync hiccup must not blank the page */
  }
  const { data } = await supabase
    .from('sd_po_closure')
    .select('*')
    .order('easycom_completed_at', { ascending: false, nullsFirst: false })
    .limit(PAGE_SIZE);
  return ((data ?? []) as PoClosure[]).map((r) => ({
    ...r,
    productCode: r.po_ref_num.split('/')[2]?.trim() || null,
    compliance: computeClosureCompliance(r),
  }));
}

/**
 * Open (not-yet-closed) closures with derived compliance, read-only (NO sync) —
 * for the dashboard's Pending Closure panel. Row creation is handled by the
 * twice-daily BqSync + the /po-closure page, so the high-traffic dashboard stays
 * a pure read.
 */
export async function loadOpenClosures(): Promise<PoClosureView[]> {
  const supabase = await client();
  const { data } = await supabase
    .from('sd_po_closure')
    .select('*')
    .is('closed_at', null)
    .order('easycom_completed_at', { ascending: true, nullsFirst: false })
    .limit(PAGE_SIZE);
  return ((data ?? []) as PoClosure[]).map((r) => ({
    ...r,
    productCode: r.po_ref_num.split('/')[2]?.trim() || null,
    compliance: computeClosureCompliance(r),
  }));
}

/** Open (issued/approved) POs grouped for the submission/closure table. */
export async function loadPoSubmissions(): Promise<PoSubmissionGroup[]> {
  const supabase = await client();
  const rows: Record<string, unknown>[] = [];
  for (let from = 0; ; from += PAGE_SIZE) {
    const { data } = await supabase
      .from('sd_po_lines_enriched')
      .select(
        'po_number, po_ref_num, vendor_code, vendor_name, product_code, product_variant, size, sku, original_qty, pending_qty, item_price, po_date, expected_delivery_date',
      )
      .eq('po_status_code', 3)
      .range(from, from + PAGE_SIZE - 1);
    if (!data?.length) break;
    rows.push(...(data as Record<string, unknown>[]));
    if (data.length < PAGE_SIZE) break;
  }

  const { data: closures } = await supabase.from('sd_po_closure_decision').select('po_number, status');
  const closureByPo = new Map(
    ((closures ?? []) as { po_number: string; status: SdStatus }[]).map((c) => [
      String(c.po_number),
      c.status,
    ]),
  );

  const groups = new Map<string, PoSubmissionGroup>();
  for (const r of rows) {
    const po = String(r.po_number ?? '');
    if (!po) continue;
    const edd = (r.expected_delivery_date as string | null) ?? null;
    const g =
      groups.get(po) ??
      ({
        po_number: po,
        po_ref_num: (r.po_ref_num as string | null) ?? null,
        vendor_code: (r.vendor_code as string | null) ?? null,
        vendor_name: (r.vendor_name as string | null) ?? null,
        po_date: (r.po_date as string | null) ?? null,
        expected_delivery_date: edd,
        product_codes: [],
        original_qty: 0,
        pending_qty: 0,
        closureStatus: closureByPo.get(po) ?? 'draft',
        lines: [],
      } as PoSubmissionGroup);
    const pc = String(r.product_code ?? '');
    if (pc && !g.product_codes.includes(pc)) g.product_codes.push(pc);
    g.original_qty += Number(r.original_qty) || 0;
    g.pending_qty += Number(r.pending_qty) || 0;
    if (edd && (!g.expected_delivery_date || edd < g.expected_delivery_date)) {
      g.expected_delivery_date = edd;
    }
    g.lines.push({
      sku: (r.sku as string | null) ?? null,
      product_variant: (r.product_variant as string | null) ?? null,
      size: (r.size as string | null) ?? null,
      original_qty: Number(r.original_qty) || 0,
      pending_qty: Number(r.pending_qty) || 0,
      item_price: r.item_price != null ? Number(r.item_price) : null,
      expected_delivery_date: edd,
    });
    groups.set(po, g);
  }
  return [...groups.values()].sort((a, b) =>
    (a.expected_delivery_date ?? '').localeCompare(b.expected_delivery_date ?? ''),
  );
}
