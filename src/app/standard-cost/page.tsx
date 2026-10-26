import { redirect } from 'next/navigation';
import { FormLayout, Notice } from '@/components/forms/form-layout';
import {
  currentUser,
  loadCostStandards,
  loadEfobFabricCost,
  loadMaterialCodeInfo,
  loadMaterialStandardCosts,
  loadProductCatalog,
  loadStandardCostRateHistory,
  loadMaterialStandardCostRateHistory,
  loadStandardCosts,
  loadCmtpSubitems,
  loadHiddenStandardCostCodes,
  NotConfiguredError,
} from '@/lib/forms/queries';
import { FinishedGoodsCostSupport, StandardCostClient } from './standard-cost-client';
import { CostTrackTabs } from './cost-track-tabs';
import type { StandardCostRateHistory } from '@/lib/forms/types';
import { loadCostWorkflow, loadMaterialCostWorkflow } from '@/lib/standard-cost-workflow.server';
import { CostWorkflowHistory, MaterialCostWorkflowHistory } from './workflow-panel';
import { FinishedGoodsCostTable } from './finished-goods-cost-table';
import { loadFinishedGoodsCostProducts } from '@/lib/finished-goods-cost.server';
import { finishedGoodsCostStatus, type FinishedGoodsCostRevision } from '@/lib/finished-goods-cost';

export const dynamic = 'force-dynamic';

export default async function StandardCostPage({
  searchParams,
}: {
  searchParams: Promise<{ track?: string; open?: string; status?: string }>;
}) {
  const params = await searchParams;
  const track = params.track === 'material' ? 'material' : 'fg';
  const materialStatus = ['summary_not_added', 'summary_pending', 'signed_off', 'summary_partial', 'summary_resubmit'].includes(params.status ?? '')
    ? params.status!
    : 'all';
  const openCode = params.open ?? null;
  // Older links used ?open=CODE to expand a row. The record has its own page now.
  if (openCode) {
    redirect(
      `/standard-cost/${encodeURIComponent(openCode)}${track === 'material' ? '?track=material' : ''}`,
    );
  }

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

  // The list is cards now: code, name, three rates, when the cost was last accepted. The
  // cost sheet itself (CMTP lines, fabric buildup, revisions, margin) belongs to one
  // product's page, so none of it is fetched or shipped to the browser here any more.
  const [costs, standards, efob, catalog, rateHistory] =
    track === 'material'
      ? [
          await loadMaterialStandardCosts(),
          await loadCostStandards(),
          await loadEfobFabricCost(),
          [],
          await loadMaterialStandardCostRateHistory(),
        ]
      : await Promise.all([
          loadStandardCosts(true),
          loadCostStandards(),
          loadEfobFabricCost(),
          loadProductCatalog(),
          loadStandardCostRateHistory(),
        ]);

  // Soft-deleted codes for this track — re-adding one restores it (un-hide) with data intact.
  const hiddenCodes = track === 'material' ? await loadHiddenStandardCostCodes(true) : [];

  // Material cards show what a code IS ("Cotton Slub · Indigo · Dyed"), from the material master.
  const materialNames = track === 'material' ? await loadMaterialCodeInfo() : {};
  const cmtpSubitems = track === 'fg' ? await loadCmtpSubitems() : {};

  const workflow = track === 'fg' ? await loadCostWorkflow() : null;
  const materialWorkflow = track === 'material' ? await loadMaterialCostWorkflow(costs) : null;
  const masterProducts = track === 'fg' ? await loadFinishedGoodsCostProducts() : null;
  const summary = { 'Cost Not Added': 0, 'Approval Pending': 0, 'Approved': 0, 'Partially Approved': 0, 'Re-Submit': 0 };
  const summaryText: Record<keyof typeof summary, { definition: string; logic: string }> = {
    'Cost Not Added': { definition: 'Costs not entered or still being prepared.', logic: 'Not added + Draft' },
    'Approval Pending': { definition: 'Submitted costs waiting for approval.', logic: 'Approval Pending status' },
    'Approved': { definition: 'Approved standard costs available for planning.', logic: 'Approved status, with no open submission' },
    'Partially Approved': { definition: 'Some amended sections are approved; others await review.', logic: 'Pending amendment with approved sections' },
    'Re-Submit': { definition: 'Returned costs needing correction and resubmission.', logic: 'Rework / Reassign + Rejected / Discarded' },
  };
  if (masterProducts) {
    const byCode = new Map(costs.map(cost => [cost.product_code.toUpperCase(), cost]));
    const openByCode = new Map<string, FinishedGoodsCostRevision>();
    for (const revision of workflow?.revisions ?? []) {
      const code = revision.product_code.toUpperCase();
      if (revision.status !== 'approved' && (!openByCode.has(code) || openByCode.get(code)!.id < revision.id)) openByCode.set(code, revision);
    }
    for (const product of masterProducts.products) {
      const status = finishedGoodsCostStatus(byCode.get(product.code), rateHistory[product.code] ?? [], openByCode.get(product.code));
      if (status === 'Not added' || status === 'Draft') summary['Cost Not Added']++;
      else if (status === 'Rework / Reassign' || status === 'Rejected / Discarded') summary['Re-Submit']++;
      else summary[status]++;
    }
  } else {
    for (const cost of costs) {
      const stage = cost.neg_stage ?? '';
      if (stage === 'signed_off' || cost.status === 'approved') summary.Approved++;
      else if (stage === 'proposed' || stage === 'target_set' || stage === 'rate_submitted') summary['Approval Pending']++;
      else if (stage === 'renegotiate' || stage === 'rejected' || cost.status === 'rejected') summary['Re-Submit']++;
      else summary['Cost Not Added']++;
    }
  }

  return (
    <FormLayout
      title="Standard Cost"
      subtitle={
        track === 'material'
          ? 'Job Work / Purchase rates per material. Approved rates value the Buying Plan material track.'
          : 'Submit complete new costs or amend approved cost sections. Approved Job / FOB / E-FOB rates drive Buying Plan values.'
      }
      active="/standard-cost"
      role={user.role}
      userEmail={user.email}
      allowedPages={user.allowed_pages ?? null}
      accent="purple"
    >
      <CostTrackTabs track={track} />
      <section className="scw-summary" aria-label="Standard Cost status summary">
        {(Object.keys(summary) as (keyof typeof summary)[]).map(label => {
          const status = ({
            'Cost Not Added': 'summary_not_added',
            'Approval Pending': 'summary_pending',
            Approved: 'signed_off',
            'Partially Approved': 'summary_partial',
            'Re-Submit': 'summary_resubmit',
          } as const)[label];
          const content = <><span>{label}</span><strong>{summary[label].toLocaleString('en-IN')}</strong>
            <p className="scw-summary-definition">{summaryText[label].definition}</p>
            <small className="scw-summary-logic">{summaryText[label].logic}</small></>;
          const href = track === 'material'
            ? `/standard-cost?track=material&status=${status}#material-cost-sheet`
            : `/standard-cost?status=${status}#finished-goods-cost-sheet`;
          return <a className="scw-summary-card sc-fg-metric scw-summary-filter" key={label} href={href}>{content}</a>;
        })}
        <p className="scw-summary-note">Each {track === 'material' ? 'material' : 'product'} is counted once using its current cost status. Counts cover all loaded master {track === 'material' ? 'materials' : 'products'} and do not change with table filters.</p>
      </section>
      {workflow?.ready && workflow.revisions.some(r => r.status !== 'approved') && <section className="scw-panel">
        <h2>Submissions and amendments</h2>
        {workflow.revisions.filter(r => r.status !== 'approved').map(r => <p key={r.id}><a href={`/standard-cost/${encodeURIComponent(r.product_code)}`}>{r.product_code} · {r.kind === 'new' ? 'New submission' : 'Amendment'} #{r.id}</a> · {r.status} · {r.owner}</p>)}
      </section>}
      {masterProducts ? <><FinishedGoodsCostTable key={`fg-${materialStatus}`} products={masterProducts.products} costs={costs}
        revisions={workflow?.revisions.map(({id,product_code,status,approved_sections}) => ({id,product_code,status,approved_sections}))}
        history={rateHistory as Record<string, StandardCostRateHistory[]>}
        canEdit={user.role === 'team' || user.role === 'admin'} warning={masterProducts.warning} initialStatus={materialStatus} />
        <FinishedGoodsCostSupport standards={standards} cmtpSubitems={cmtpSubitems} editable={user.role === 'team' || user.role === 'admin'} />
      </> : <StandardCostClient key={`material-${materialStatus}`}
        costs={costs}
        standards={standards}
        efob={efob}
        catalog={catalog}
        rateHistory={rateHistory as Record<string, StandardCostRateHistory[]>}
        hiddenCodes={hiddenCodes}
        materialNames={materialNames}
        role={user.role}
        track={track}
        initialStageFilter={materialStatus}
      />}
      {workflow && user.role === 'admin' && (workflow.ready
        ? <details className="scw-changelog-disclosure"><summary>Standard Cost changelog — admin</summary><CostWorkflowHistory events={workflow.events} title="Standard Cost changelog — admin" /></details>
        : <Notice tone="error">{workflow.error}</Notice>)}
      {materialWorkflow && user.role === 'admin' && (materialWorkflow.ready
        ? <details className="scw-changelog-disclosure"><summary>Standard Cost changelog — admin</summary><MaterialCostWorkflowHistory events={materialWorkflow.events} /></details>
        : <Notice tone="error">{materialWorkflow.error}</Notice>)}
    </FormLayout>
  );
}
