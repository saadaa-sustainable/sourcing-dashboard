/**
 * Approval-time context (spec item 1) — the DOQ / stock / DOH / in-stock
 * metrics the approver sees inline per buying-plan line, so routine lines can
 * be approved without leaving the screen.
 *
 * Pure + presentation-safe (no server imports): the loader supplies the SKU
 * rows and the product-level DOQ/stock; this file only does the maths, so it's
 * unit-testable and importable by the client panel.
 *
 * Exclusion rule — the SAME one Product Master's status rollup uses
 * ([[product-state-rollup]]): NPD-family and discontinued/to-be-discontinued
 * SKUs are excluded from BOTH the numerator and denominator of every in-stock
 * rate. Do not invent a second rule here.
 */

import { isNpdFamily } from '@/lib/doq-dashboard';

export const COLOR_IN_STOCK_THRESHOLD_DEFAULT = 0.75;

/**
 * Buying-plan approval lines are labelled "<product_code> · <n> pcs" (see the
 * queue builder). Extract the product code — the key for the context map — from
 * that label, so we don't need to widen the shared line type (owned elsewhere).
 */
export function productCodeFromLineLabel(label: string): string {
  return label.split('·')[0].trim();
}

/** One garment SKU of a product (from sd_oos_calculation). */
export type ContextSku = {
  color: string | null;
  size: string | null;
  productStatus: string | null;
  currentStock: number;
};

/** Product-level figures (from sd_replenishment_by_product). */
export type ContextProductLevel = {
  ipdoq: number; // the Replenishment IPDOQ, product-level
  currentStock: number;
  inProcess: number;
};

export type ApprovalContext = {
  doq: number; // product IPDOQ
  currentStock: number;
  inProcess: number;
  /** Days of Hand = (stock + in-process) / DOQ. Null when DOQ ≤ 0. */
  doh: number | null;
  ongoingSkuCount: number;
  /** In-stock SKUs ÷ ongoing SKUs. Null when there are no ongoing SKUs. */
  skuInStockRate: number | null;
  totalColors: number;
  qualifyingColors: number;
  /** Colours meeting the size threshold ÷ total colours. Null when no colours. */
  colorInStockRate: number | null;
};

/** A SKU is discontinued (excluded) if its state mentions "discontinu". */
export function isDiscontinued(state: string | null): boolean {
  return /discontinu/i.test(state ?? '');
}

/** Ongoing = launched and live: not NPD-family, not discontinued. */
export function isOngoing(state: string | null): boolean {
  return !isNpdFamily(state) && !isDiscontinued(state);
}

const r2 = (n: number) => Math.round(n * 100) / 100;

/**
 * Compute the inline context for one product.
 *  - In-Stock (SKU): among ongoing SKUs, the share with stock > 0.
 *  - Color In-Stock (two-layer): per colour, size-in-stock rate = in-stock
 *    sizes ÷ its sizes; a colour "qualifies" when that ≥ threshold; the rollup
 *    is qualifying colours ÷ total colours. (Spec example: 14 of 20 → 0.70.)
 */
export function computeApprovalContext(
  skus: ContextSku[],
  product: ContextProductLevel,
  threshold = COLOR_IN_STOCK_THRESHOLD_DEFAULT,
): ApprovalContext {
  const ongoing = skus.filter((s) => isOngoing(s.productStatus));
  const inStock = ongoing.filter((s) => s.currentStock > 0).length;

  // Group ongoing SKUs by colour → size-level in-stock fraction per colour.
  const byColor = new Map<string, { total: number; inStock: number }>();
  for (const s of ongoing) {
    const key = (s.color ?? '').trim() || '—';
    const c = byColor.get(key) ?? { total: 0, inStock: 0 };
    c.total += 1;
    if (s.currentStock > 0) c.inStock += 1;
    byColor.set(key, c);
  }
  const totalColors = byColor.size;
  let qualifyingColors = 0;
  for (const c of byColor.values()) {
    if (c.total > 0 && c.inStock / c.total >= threshold) qualifyingColors += 1;
  }

  const doq = product.ipdoq;
  const doh = doq > 0 ? r2((product.currentStock + product.inProcess) / doq) : null;

  return {
    doq: r2(doq),
    currentStock: Math.round(product.currentStock),
    inProcess: Math.round(product.inProcess),
    doh,
    ongoingSkuCount: ongoing.length,
    skuInStockRate: ongoing.length ? r2(inStock / ongoing.length) : null,
    totalColors,
    qualifyingColors,
    colorInStockRate: totalColors ? r2(qualifyingColors / totalColors) : null,
  };
}
