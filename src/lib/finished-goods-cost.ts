import type { StandardCost, StandardCostRateHistory } from './forms/types';
import type { CostRevision } from './standard-cost-workflow';

export const FINISHED_GOODS_COST_STATUSES = ['Not added', 'Draft', 'Approval Pending', 'Partially Approved', 'Approved', 'Rework / Reassign', 'Rejected / Discarded'] as const;
export type FinishedGoodsCostRevision = Pick<CostRevision, 'id' | 'product_code' | 'status' | 'approved_sections'>;

export function finishedGoodsCostStatus(cost: StandardCost | undefined, history: StandardCostRateHistory[], revision?: FinishedGoodsCostRevision): typeof FINISHED_GOODS_COST_STATUSES[number] {
  if (revision) {
    if (revision.status === 'rework') return 'Rework / Reassign';
    if (revision.status === 'rejected') return 'Rejected / Discarded';
    if (revision.status === 'pending') return revision.approved_sections.length ? 'Partially Approved' : 'Approval Pending';
    if (revision.status === 'draft') return 'Draft';
  }
  if (!cost) return hasApprovedProductCost(cost, history) ? 'Approved' : 'Not added';
  if (cost.status === 'rework' || cost.neg_stage === 'renegotiate') return 'Rework / Reassign';
  if (cost.status === 'rejected' || cost.neg_stage === 'rejected') return 'Rejected / Discarded';
  if (['submitted', 'pending_l1', 'pending_l2'].includes(cost.status) || ['proposed', 'rate_submitted'].includes(cost.neg_stage ?? '')) return 'Approval Pending';
  if (hasApprovedProductCost(cost, history)) return 'Approved';
  if (!cost.documented && !cost.fabric_code && [cost.job_cost,cost.fob_cost,cost.efob_cost,cost.cm_cost].every(n => n == null)) return 'Not added';
  return 'Draft';
}

/** Operational saves/freezes must not change the date of the accepted standard. */
export function finishedGoodsCostUpdatedAt(cost: StandardCost | undefined, history: StandardCostRateHistory[]): string | null {
  const dates = [cost?.approved_at, ...history.map(h => h.accepted_at)].filter((date): date is string => !!date && Number.isFinite(Date.parse(date)));
  return dates.sort((a,b) => Date.parse(b)-Date.parse(a))[0] ?? null;
}

export type FinishedGoodsCostProduct = {
  code: string;
  name: string;
  source: 'EasyEcom' | 'NPD Tracker';
  npdId: number | null;
  skus: string[];
};

export function hasApprovedProductCost(cost: StandardCost | undefined, history: StandardCostRateHistory[] = []): boolean {
  return history.length > 0 || !!cost && (cost.status === 'approved' || cost.neg_stage === 'signed_off');
}

/** Match the existing catalog's product-variant convention, without inventing typed products. */
export function easyEcomCostProducts(
  skus: { sku: string; product_variant: string | null; product_name: string | null }[],
  catalog: { product_code: string; product_name: string | null }[],
): FinishedGoodsCostProduct[] {
  const names = new Map(catalog.map(p => [p.product_code.toUpperCase(), p.product_name]));
  const codes = [...names.keys()].sort((a,b) => b.length-a.length);
  const products = new Map<string, FinishedGoodsCostProduct>();
  for (const row of skus) {
    const variant = row.product_variant?.trim().toUpperCase();
    const code = variant ? (variant.length > 2 ? variant.slice(0,-2) : variant) : codes.find(c => row.sku.toUpperCase().startsWith(c));
    if (!code) continue;
    const product = products.get(code) ?? { code, name: names.get(code) || row.product_name || '', source: 'EasyEcom' as const, npdId: null, skus: [] };
    product.skus.push(row.sku);
    products.set(code, product);
  }
  return [...products.values()];
}
