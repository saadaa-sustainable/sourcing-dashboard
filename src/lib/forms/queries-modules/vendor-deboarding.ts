import 'server-only';
import { client } from './_shared';
import { eeVendorActive } from '@/lib/business-logic';
import type { DeboardedVendor, VendorDeboardingRequest, VendorDeboardingVendor } from '../types';

const key = (v: string | null | undefined) => (v ?? '').trim().toUpperCase();

/**
 * Vendors whose de-boarding has been APPROVED, keyed by upper-cased code. Every page that
 * lists or picks a vendor reads this so the decision is visible where it matters — a PO
 * form, the capacity sheet, the master, the scorecard — rather than only on the request
 * page. A plain object, so it crosses into client components as-is. Never throws.
 */
export async function loadDeboardedVendors(): Promise<Record<string, DeboardedVendor>> {
  const out: Record<string, DeboardedVendor> = {};
  try {
    const supabase = await client();
    const { data } = await supabase
      .from('sd_vendor_deboarding_request')
      .select('vendor_code, approved_at, reason')
      .eq('status', 'approved')
      .order('approved_at', { ascending: false })
      .limit(500);
    for (const r of (data ?? []) as { vendor_code: string; approved_at: string | null; reason: string }[]) {
      const code = key(r.vendor_code);
      if (code && !out[code]) out[code] = { approvedAt: r.approved_at ?? '', reason: r.reason };
    }
  } catch {
    /* a flag that cannot load must not take a page down */
  }
  return out;
}

/**
 * Everything the De-Boarding page needs: past requests, and every vendor in the master
 * with the evidence the form used to ask for by hand — POs done, the three delay
 * buckets (sd_vendor_deboarding_stats, from completed POs), the rejection rate at goods
 * receipt (sd_vendor_grn_reject) and how many POs are open with them right now
 * (sd_vendor_in_process), so an approver sees what de-boarding would strand.
 */
export async function loadVendorDeboarding(): Promise<{
  requests: VendorDeboardingRequest[];
  vendors: VendorDeboardingVendor[];
}> {
  const supabase = await client();
  const [{ data: requests }, { data: masters }, { data: stats }, { data: rejects }, { data: open }] =
    await Promise.all([
      supabase
        .from('sd_vendor_deboarding_request')
        .select('*')
        .order('id', { ascending: false })
        .limit(500),
      supabase
        .from('vendor_master_data')
        .select('vendor_code, vendor_name, merchant_name, primary_type, onboarding_date, is_active, ee_status')
        .order('vendor_name'),
      supabase
        .from('sd_vendor_deboarding_stats')
        .select('vendor_code, pos_done, pos_late_15d, pos_late_1m, pos_late_over_1m'),
      supabase.from('sd_vendor_grn_reject').select('vendor_key, reject_rate_pct'),
      supabase.from('sd_vendor_in_process').select('vendor_code, open_po_count'),
    ]);

  type Stat = { vendor_code: string; pos_done: number; pos_late_15d: number; pos_late_1m: number; pos_late_over_1m: number };
  const statByCode = new Map(((stats ?? []) as Stat[]).map((s) => [key(s.vendor_code), s]));
  const rejectByCode = new Map(
    ((rejects ?? []) as { vendor_key: string | null; reject_rate_pct: number | null }[]).map((r) => [
      key(r.vendor_key),
      r.reject_rate_pct == null ? null : Number(r.reject_rate_pct),
    ]),
  );
  const openByCode = new Map(
    ((open ?? []) as { vendor_code: string | null; open_po_count: number | null }[]).map((o) => [
      key(o.vendor_code),
      Number(o.open_po_count) || 0,
    ]),
  );

  type Master = {
    vendor_code: string | null; vendor_name: string | null; merchant_name: string | null;
    primary_type: string | null; onboarding_date: string | null; is_active: boolean | null; ee_status: string | null;
  };
  const vendors: VendorDeboardingVendor[] = ((masters ?? []) as Master[])
    .filter((m) => key(m.vendor_code))
    .map((m) => {
      const code = key(m.vendor_code);
      const s = statByCode.get(code);
      // EasyEcom's status is the authority once synced; the sheet flag is the fallback.
      const ee = eeVendorActive(m.ee_status);
      return {
        vendor_code: code,
        vendor_name: m.vendor_name ?? code,
        merchant: m.merchant_name ?? '',
        primary_type: m.primary_type ?? '',
        onboarding_date: m.onboarding_date,
        isActive: ee ?? !!m.is_active,
        openPoCount: openByCode.get(code) ?? 0,
        stats: s
          ? {
              posDone: Number(s.pos_done) || 0,
              late15d: Number(s.pos_late_15d) || 0,
              late1m: Number(s.pos_late_1m) || 0,
              lateOver1m: Number(s.pos_late_over_1m) || 0,
            }
          : null,
        rejectionPct: rejectByCode.get(code) ?? null,
      };
    });

  return {
    requests: (requests ?? []) as VendorDeboardingRequest[],
    vendors,
  };
}
