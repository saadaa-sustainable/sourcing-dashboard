import { redirect } from 'next/navigation';
import Link from 'next/link';
import { FormLayout, Notice } from '@/components/forms/form-layout';
import {
  currentUser,
  loadCmtpComponents,
  loadCmtpSubitems,
  loadFabricCostBase,
  loadProductCatalog,
  loadStandardCostLines,
  loadStandardCostRateHistory,
  loadStandardCosts,
  loadAnalyticsRules,
  NotConfiguredError,
} from '@/lib/forms/queries';
import { StandardCostDetailClient } from './cost-detail-client';
import type { StandardCostRateHistory } from '@/lib/forms/types';
import { loadCmtpRevisions } from '@/lib/standard-cost-revisions.server';
import { loadProductFabricMap } from '@/lib/product-fabric.server';
import { loadTempProductMap } from '@/lib/temp-product.server';

export const dynamic = 'force-dynamic';

/**
 * One product's full cost record, on its own URL. The Finished Goods sheet lists products as
 * cards; "Cost Details" lands here. Material codes keep the single-screen sheet, so this
 * route is Finished Goods only.
 */
export default async function StandardCostDetailPage({
  params,
}: {
  params: Promise<{ code: string }>;
}) {
  const { code: raw } = await params;
  const code = decodeURIComponent(raw);

  let user;
  try {
    user = await currentUser();
  } catch (error) {
    if (error instanceof NotConfiguredError) {
      return (
        <FormLayout title="Standard Cost" active="/standard-cost" role="viewer">
          <Notice tone="error">{error.message}</Notice>
        </FormLayout>
      );
    }
    throw error;
  }
  if (!user) redirect('/login');

  const [costs, lines, fabricBase, cmtp, catalog, rateHistory, cmtpSubitems] = await Promise.all([
    loadStandardCosts(),
    loadStandardCostLines(),
    loadFabricCostBase(),
    loadCmtpComponents(),
    loadProductCatalog(),
    loadStandardCostRateHistory(),
    loadCmtpSubitems(),
  ]);

  const cost = costs.find((c) => c.product_code.toUpperCase() === code.toUpperCase()) ?? null;

  if (!cost) {
    return (
      <FormLayout
        title="Standard Cost"
        active="/standard-cost"
        role={user.role}
        userEmail={user.email}
        allowedPages={user.allowed_pages ?? null}
        accent="purple"
      >
        <Notice tone="error">
          No Finished Goods cost record for &ldquo;{code}&rdquo;.{' '}
          <Link href="/standard-cost">Back to all products</Link>
        </Notice>
      </FormLayout>
    );
  }

  const [cmtpRevisions, productFabric, tempProducts, rules] = await Promise.all([
    loadCmtpRevisions([cost.product_code]),
    loadProductFabricMap(),
    loadTempProductMap(),
    loadAnalyticsRules(),
  ]);

  // Fabric buildup map + code list — the Fabric Cost tab reads these from the master.
  const fabricByCode: Record<string, { grey: number | null; processing: number | null; finished: number | null }> = {};
  const fabricCodes: string[] = [];
  for (const f of fabricBase) {
    fabricCodes.push(f.fabric_code);
    fabricByCode[f.fabric_code] = {
      grey: f.grey_rate != null ? Number(f.grey_rate) : null,
      processing: f.processing_cost != null ? Number(f.processing_cost) : null,
      finished: f.finished_fabric_cost != null ? Number(f.finished_fabric_cost) : null,
    };
  }

  const history = (rateHistory as Record<string, StandardCostRateHistory[]>)[cost.product_code] ?? [];
  const productName =
    catalog.find((p) => p.product_code.toUpperCase() === cost.product_code.toUpperCase())
      ?.product_name ?? null;

  return (
    <FormLayout
      title="Standard Cost"
      subtitle={`${cost.product_code}${productName ? ` · ${productName}` : ''}`}
      active="/standard-cost"
      role={user.role}
      userEmail={user.email}
      allowedPages={user.allowed_pages ?? null}
      accent="purple"
    >
      <StandardCostDetailClient
        cost={cost}
        productName={productName}
        lines={lines.filter((l) => l.product_code === cost.product_code)}
        cmtp={cmtp.filter((c) => c.product_code === cost.product_code)}
        cmtpSubitems={cmtpSubitems as Record<string, string[]>}
        fabricBase={fabricByCode}
        fabricCodes={fabricCodes}
        history={history}
        revisions={cmtpRevisions[cost.product_code] ?? []}
        masterFabric={productFabric[cost.product_code] ?? null}
        temp={tempProducts[cost.product_code]}
        catalog={catalog}
        role={user.role}
        marginPct={rules.margin_pct / 100}
      />
    </FormLayout>
  );
}
