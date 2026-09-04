import { loadDashboardData } from '@/lib/data';
import { loadAnalyticsExtras, loadAnalyticsRules } from '@/lib/forms/queries';

/**
 * Product objective one-pager (DAM principle: one base dimension = Product, full
 * picture around it). Consolidates the Product-anchored facets that today live as
 * separate Main-Dashboard cards — availability (Stockout Risk + OOS), replenishment
 * need, and lifecycle (Discontinued products still on open POs) — into one view with
 * a per-variant stockout table. Assembled by REUSING loadAnalyticsExtras; no
 * recomputation, source cards untouched.
 */
export type AbcClass = 'A' | 'B' | 'C' | 'D';

export type ProductHubRow = {
  productVariant: string;
  productCode: string | null;
  productName: string | null;
  abcClass: AbcClass;
  currentStock: number;
  doq45: number;
  oos: boolean;
};

export type ProductHubData = {
  summary: {
    totalSkus: number | null;
    zeroStock: number | null;
    dataAsOf: string | null;
    stockoutGaps: number;
    byClass: Record<AbcClass, number>;
    replenishmentVariants: number | null;
    rop30Qty: number | null;
    oosVariants: number | null;
    discontinuedOpenPoCount: number | null;
    discontinuedOpenPoQty: number | null;
    discontinuedPlanLines: number | null;
  };
  rows: ProductHubRow[];
};

const CLASS_ORDER: Record<AbcClass, number> = { A: 0, B: 1, C: 2, D: 3 };

export async function loadProductHub(): Promise<ProductHubData> {
  const [dash, rules] = await Promise.all([loadDashboardData(), loadAnalyticsRules()]);

  let extras: Awaited<ReturnType<typeof loadAnalyticsExtras>> | null = null;
  try {
    extras = await loadAnalyticsExtras(
      dash.pendingPos.map((p) => ({
        code: (p.product_code ?? '').trim(),
        variant: (p.product_variant ?? '').trim(),
        qty: Number(p.pending_qty_actual) || 0,
      })),
      rules,
    );
  } catch {
    extras = null;
  }

  const gaps = extras?.stockoutGaps ?? [];
  const rows: ProductHubRow[] = gaps
    .map((g) => ({
      productVariant: g.product_variant,
      productCode: g.product_code,
      productName: g.product_name,
      abcClass: g.abc_class,
      currentStock: g.current_stock,
      doq45: g.doq_45,
      oos: g.oos,
    }))
    .sort((a, b) => CLASS_ORDER[a.abcClass] - CLASS_ORDER[b.abcClass] || b.doq45 - a.doq45);

  const byClass: Record<AbcClass, number> = { A: 0, B: 0, C: 0, D: 0 };
  for (const r of rows) byClass[r.abcClass] += 1;

  return {
    summary: {
      totalSkus: extras?.oosSummary?.totalSkus ?? null,
      zeroStock: extras?.oosSummary?.zeroStock ?? null,
      dataAsOf: extras?.oosSummary?.dataAsOf ?? null,
      stockoutGaps: rows.length,
      byClass,
      replenishmentVariants: extras?.replenishment?.variants ?? null,
      rop30Qty: extras?.replenishment?.rop30Qty ?? null,
      oosVariants: extras?.replenishment?.oosVariants ?? null,
      discontinuedOpenPoCount: extras?.discontinued?.openPoCount ?? null,
      discontinuedOpenPoQty: extras?.discontinued?.openPoQty ?? null,
      discontinuedPlanLines: extras?.discontinued?.planLineCount ?? null,
    },
    rows,
  };
}
