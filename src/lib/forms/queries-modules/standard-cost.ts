import 'server-only';
import { client, PAGE_SIZE } from './_shared';
import type {
  StandardCost,
  CostStandards,
  StandardCostLine,
  CmtpComponent,
  StandardCostRateHistory,
} from '../types';

/** Every standard-cost row, for the Standard Cost sheet page. */
export async function loadStandardCosts(): Promise<StandardCost[]> {
  const supabase = await client();
  const { data } = await supabase
    .from('sd_standard_cost')
    .select('*')
    .eq('hidden', false) // soft-deleted (hidden) rows are kept but not listed
    .order('product_code')
    .limit(PAGE_SIZE);
  return (data ?? []) as StandardCost[];
}

/** Product codes soft-deleted from the Standard Cost worklist (fg or material) — so
 *  re-adding one RESTORES it (un-hide) instead of overwriting its kept data. */
export async function loadHiddenStandardCostCodes(material = false): Promise<string[]> {
  const supabase = await client();
  const { data } = await supabase
    .from(material ? 'sd_material_standard_cost' : 'sd_standard_cost')
    .select('product_code')
    .eq('hidden', true);
  return ((data ?? []) as { product_code: string }[]).map((r) => r.product_code);
}

/** The document-once standard cost fields (singleton). */
export async function loadCostStandards(): Promise<CostStandards> {
  const supabase = await client();
  const { data } = await supabase.from('sd_cost_standards').select('*').eq('id', 1).maybeSingle();
  return (
    (data as CostStandards | null) ?? {
      id: 1,
      fabric_cost: null,
      dyeing_cost: null,
      shrinkage_pct: null,
      margin_pct: null,
      payment_terms: null,
      updated_by: null,
      updated_at: '',
    }
  );
}

/** Colour/size cost detail lines (all products), for the Standard Cost expand panels. */
export async function loadStandardCostLines(): Promise<StandardCostLine[]> {
  const supabase = await client();
  const { data } = await supabase
    .from('sd_standard_cost_line')
    .select('*')
    .order('product_code')
    .order('colour')
    .order('size')
    .limit(PAGE_SIZE);
  return (data ?? []) as StandardCostLine[];
}

/** product_code → standard CM (CMTP total), to pre-fill the PO cost pivot. */
export async function loadStandardCmByCode(): Promise<Record<string, number>> {
  const supabase = await client();
  const { data } = await supabase
    .from('sd_standard_cost')
    .select('product_code, cm_cost')
    .not('cm_cost', 'is', null)
    .limit(PAGE_SIZE);
  const map: Record<string, number> = {};
  for (const r of (data ?? []) as { product_code: string; cm_cost: number | null }[]) {
    if (r.cm_cost != null) map[r.product_code] = Number(r.cm_cost);
  }
  return map;
}

/** CMTP cost-breakdown line items (all products), for the Standard Cost CMTP view. */
export async function loadCmtpComponents(): Promise<CmtpComponent[]> {
  const supabase = await client();
  const { data } = await supabase
    .from('sd_cmtp_component')
    .select('*')
    .order('product_code')
    .order('position')
    .limit(PAGE_SIZE);
  return (data ?? []) as CmtpComponent[];
}

/**
 * The managed CMTP sub-item master, grouped by head (category → sub-item names).
 * Feeds the sub-item dropdown on the Standard Cost CMTP breakdown so people pick
 * a standardized name instead of free-typing near-duplicates.
 */
export async function loadCmtpSubitems(): Promise<Record<string, string[]>> {
  const supabase = await client();
  const { data } = await supabase
    .from('sd_cmtp_subitem')
    .select('category, name, is_active')
    .eq('is_active', true)
    .order('category')
    .order('name')
    .limit(PAGE_SIZE);
  const map: Record<string, string[]> = {};
  ((data ?? []) as { category: string; name: string }[]).forEach((r) => {
    (map[r.category] ??= []).push(r.name);
  });
  return map;
}

/** Every material-cost row, for the Material tab of the Standard Cost page. */
export async function loadMaterialStandardCosts(): Promise<StandardCost[]> {
  const supabase = await client();
  const { data } = await supabase
    .from('sd_material_standard_cost')
    .select('*')
    .eq('hidden', false) // soft-deleted (hidden) rows are kept but not listed
    .order('product_code')
    .limit(PAGE_SIZE);
  return (data ?? []) as StandardCost[];
}

/** Approved material rates → Map material_code → { job (Job Work), fob (Purchase) }. */
export async function loadApprovedMaterialCosts(): Promise<
  Record<string, { job: number; fob: number }>
> {
  const supabase = await client();
  const { data } = await supabase
    .from('sd_material_standard_cost')
    .select('product_code, job_cost, fob_cost, status')
    .eq('status', 'approved')
    .limit(PAGE_SIZE);
  const map: Record<string, { job: number; fob: number }> = {};
  (
    (data ?? []) as { product_code: string; job_cost: number | null; fob_cost: number | null }[]
  ).forEach((r) => {
    map[r.product_code] = { job: Number(r.job_cost) || 0, fob: Number(r.fob_cost) || 0 };
  });
  return map;
}

/** Approved standard rates per product, for the Buying Plan value calc. */
/**
 * The live standard rate per product = the LATEST ACCEPTED rate, read from the
 * rate-history table (sd_standard_cost_rate_history) so a product being
 * re-negotiated keeps its current rate until a new proposal is accepted. Falls
 * back to any approved working row that predates the history (defensive; the
 * migration backfills all approved rows, so this should be empty).
 */
export async function loadApprovedStandardCosts(): Promise<
  Record<string, { job: number; fob: number; efob: number }>
> {
  const supabase = await client();
  const map: Record<string, { job: number; fob: number; efob: number }> = {};

  // History rows, newest first — first seen per code wins (its latest accepted rate).
  const hist: { product_code: string; job_cost: number | null; fob_cost: number | null; efob_cost: number | null }[] = [];
  for (let from = 0; ; from += PAGE_SIZE) {
    const { data } = await supabase
      .from('sd_standard_cost_rate_history')
      .select('product_code, job_cost, fob_cost, efob_cost')
      .order('accepted_at', { ascending: false })
      .range(from, from + PAGE_SIZE - 1);
    if (!data?.length) break;
    hist.push(...(data as typeof hist));
    if (data.length < PAGE_SIZE) break;
  }
  for (const r of hist) {
    if (map[r.product_code]) continue; // already have the latest for this code
    map[r.product_code] = {
      job: Number(r.job_cost) || 0,
      fob: Number(r.fob_cost) || 0,
      efob: Number(r.efob_cost) || 0,
    };
  }

  // Fallback for any approved row not yet represented in history.
  const { data: approved } = await supabase
    .from('sd_standard_cost')
    .select('product_code, job_cost, fob_cost, efob_cost')
    .eq('status', 'approved')
    .limit(PAGE_SIZE);
  ((approved ?? []) as { product_code: string; job_cost: number | null; fob_cost: number | null; efob_cost: number | null }[]).forEach((r) => {
    if (map[r.product_code]) return;
    map[r.product_code] = {
      job: Number(r.job_cost) || 0,
      fob: Number(r.fob_cost) || 0,
      efob: Number(r.efob_cost) || 0,
    };
  });
  return map;
}

/** Full accepted-rate history per product, newest first — for the Rate History tab. */
export async function loadStandardCostRateHistory(): Promise<Record<string, StandardCostRateHistory[]>> {
  const supabase = await client();
  const rows: StandardCostRateHistory[] = [];
  for (let from = 0; ; from += PAGE_SIZE) {
    const { data, error } = await supabase
      .from('sd_standard_cost_rate_history')
      .select('*')
      .order('accepted_at', { ascending: false })
      .range(from, from + PAGE_SIZE - 1);
    if (error) throw new Error(`sd_standard_cost_rate_history: ${error.message}`);
    if (!data?.length) break;
    rows.push(...(data as StandardCostRateHistory[]));
    if (data.length < PAGE_SIZE) break;
  }
  const byCode: Record<string, StandardCostRateHistory[]> = {};
  for (const r of rows) (byCode[r.product_code] ??= []).push(r);
  return byCode;
}
