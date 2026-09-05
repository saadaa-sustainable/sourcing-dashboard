import 'server-only';
import { client, PAGE_SIZE } from './_shared';
import { monthStart, addMonths } from '../approval';
import { loadInProcessByVendor } from './vendor';
import type {
  PoApproval,
  PoApprovalLine,
  PoCycleTime,
  TnaLeadtimes,
  NpdBudget,
  SdStatus,
} from '../types';

/* ------------------------------------------------------------------ */
/* PO Approval                                                         */
/* ------------------------------------------------------------------ */

/**
 * Everything the PO Approval screen needs: the POs themselves, their cycle-time
 * rows (sd_po_cycle_time), the product/vendor pick-lists for the entry form, and
 * each vendor's live in-process load (sd_vendor_in_process) for the cards.
 */
export async function loadPoApprovals() {
  const supabase = await client();

  const [{ data: pos }, { data: cycle }, { data: variants }, { data: vendors }] = await Promise.all([
    supabase
      .from('sd_po_approval')
      .select('*')
      .order('id', { ascending: false })
      .limit(500),
    supabase.from('sd_po_cycle_time').select('*').limit(500),
    supabase.from('sd_active_variants').select('product_code').limit(PAGE_SIZE),
    supabase
      .from('vendor_master_data')
      .select('vendor_code, vendor_name, is_active')
      .eq('is_active', true)
      .limit(PAGE_SIZE),
  ]);

  const poIds = ((pos ?? []) as PoApproval[]).map((p) => p.id);
  const { data: poLines } = poIds.length
    ? await supabase.from('sd_po_approval_line').select('*').in('po_id', poIds)
    : { data: [] as PoApprovalLine[] };
  const linesByPo = new Map<number, PoApprovalLine[]>();
  ((poLines ?? []) as PoApprovalLine[]).forEach((l) => {
    linesByPo.set(l.po_id, [...(linesByPo.get(l.po_id) ?? []), l]);
  });

  const capacityByVendor = await loadInProcessByVendor();

  const productCodes = [
    ...new Set(
      ((variants ?? []) as { product_code: string }[])
        .map((r) => r.product_code)
        .filter(Boolean),
    ),
  ].sort();

  // Vendor code ↔ name from the vendor master (the source for auto-fill + the
  // "CODE - Full Name" display). Fall back to any codes seen in open POs.
  const vendorNames: Record<string, string> = {};
  ((vendors ?? []) as { vendor_code: string | null; vendor_name: string | null }[]).forEach((v) => {
    const code = (v.vendor_code ?? '').trim();
    if (code) vendorNames[code] = (v.vendor_name ?? '').trim();
  });
  const vendorCodes = [
    ...new Set([...Object.keys(vendorNames), ...capacityByVendor.keys()]),
  ].sort();

  const cycleById = new Map<number, PoCycleTime>();
  ((cycle ?? []) as PoCycleTime[]).forEach((c) => cycleById.set(c.id, c));

  return {
    pos: (pos ?? []) as PoApproval[],
    cycleById,
    linesByPo,
    productCodes,
    vendorCodes,
    vendorNames,
    capacityByVendor,
  };
}

/** Standard TNA lead-times (singleton) for the critical-path auto-generate. */
export async function loadTnaLeadtimes(): Promise<TnaLeadtimes> {
  const supabase = await client();
  const { data } = await supabase.from('sd_tna_leadtimes').select('*').eq('id', 1).maybeSingle();
  return (
    (data as TnaLeadtimes | null) ?? {
      id: 1,
      pp_sample_days: null,
      gpt_days: null,
      cutting_days: null,
      inline_qc_days: null,
      first_delivery_days: null,
      po_closing_days: null,
      updated_by: null,
      updated_at: '',
    }
  );
}

/* ------------------------------------------------------------------ */
/* NPD monthly budget — cap (admin-set) vs consumption (NPD POs)       */
/* ------------------------------------------------------------------ */

/**
 * The NPD budget picture for a month: the flat cap Sourcing set (or null =
 * "not set yet", never a fake number) against live consumption computed from
 * NPD purchase orders (sd_po_approval, category = 'npd'). Approved POs are the
 * committed spend; submitted/pending ones are shown separately as in-flight.
 */
export async function loadNpdBudget(month = monthStart()): Promise<NpdBudget> {
  const supabase = await client();
  const next = addMonths(month, 1);

  const [{ data: budget }, { data: pos }] = await Promise.all([
    supabase.from('sd_npd_budget').select('*').eq('plan_month', month).maybeSingle(),
    supabase
      .from('sd_po_approval')
      .select('po_qty, rate, status, approved_at, submitted_for_approval_at, timestamp_created')
      .eq('category', 'npd'),
  ]);

  let spent = 0;
  let spentCount = 0;
  let pending = 0;
  let pendingCount = 0;
  let missingRate = 0;

  const inMonth = (ts: string | null) => {
    if (!ts) return false;
    const d = ts.slice(0, 10); // YYYY-MM-DD — lexicographic compare is date-correct
    return d >= month && d < next;
  };

  for (const p of (pos ?? []) as Array<{
    po_qty: number | null;
    rate: number | null;
    status: SdStatus;
    approved_at: string | null;
    submitted_for_approval_at: string | null;
    timestamp_created: string | null;
  }>) {
    const value = Number(p.po_qty || 0) * Number(p.rate || 0);
    if (p.status === 'approved') {
      if (inMonth(p.approved_at)) {
        spent += value;
        spentCount += 1;
        if (p.rate == null) missingRate += 1;
      }
    } else if (p.status === 'submitted' || p.status === 'pending_l2') {
      if (inMonth(p.submitted_for_approval_at ?? p.timestamp_created)) {
        pending += value;
        pendingCount += 1;
      }
    }
  }

  const cap =
    budget && (budget as { cap_amount: number | null }).cap_amount != null
      ? Number((budget as { cap_amount: number }).cap_amount)
      : null;

  return {
    month,
    cap,
    note: (budget as { note: string | null } | null)?.note ?? null,
    updatedBy: (budget as { updated_by: string | null } | null)?.updated_by ?? null,
    updatedAt: (budget as { updated_at: string | null } | null)?.updated_at ?? null,
    spent,
    spentCount,
    pending,
    pendingCount,
    missingRate,
  };
}
