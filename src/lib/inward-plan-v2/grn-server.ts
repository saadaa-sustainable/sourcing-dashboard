import 'server-only';
import { pageAll } from '@/lib/forms/queries-modules/_shared';
import { context, loadPlans } from './server';
import type { PlanLine } from './types';
import type { DelayReport, GrnData, Reconciliation, SystemGrn } from './grn-types';

export async function loadGrnData(): Promise<GrnData> {
  const { db } = await context();
  const [plans, reports, reconciliations] = await Promise.all([
    loadPlans(),
    pageAll<DelayReport>(() => db.from('sd_grn_delay_tracker_v2').select('*').order('id')),
    pageAll<Reconciliation>(() => db.from('sd_inward_v2_reconciliations').select('*').order('id')),
  ]);
  const lines: PlanLine[] = [];
  for (let i = 0; i < plans.length; i += 100) {
    const ids = plans.slice(i, i + 100).map(p => p.id);
    lines.push(...await pageAll<PlanLine>(() => db.from('sd_inward_plan_v2_line').select('*').in('plan_id', ids).order('id')));
  }
  const receipts: SystemGrn[] = [];
  const ids = [...new Set(lines.map(line => line.po_detail_id).filter((id): id is string => !!id))];
  const today = new Date(Date.now() + 330 * 60_000).toISOString().slice(0, 10);
  for (let i = 0; i < ids.length; i += 100) {
    const chunk = ids.slice(i, i + 100);
    receipts.push(...await pageAll<SystemGrn>(() => db.from('sd_inward_v2_system_grn').select('*')
      .in('po_detail_id', chunk).lte('received_on', today).order('grn_detail_id')));
  }
  const productPos = [...new Set(lines.filter(line => line.planning_level === 'product').map(line => line.po_number))];
  const productKeys = new Set(lines.filter(line => line.planning_level === 'product').map(line => JSON.stringify([line.po_number, line.product_code])));
  for (let i = 0; i < productPos.length; i += 50) {
    const chunk = productPos.slice(i, i + 50);
    const rows = await pageAll<SystemGrn>(() => db.from('sd_inward_v2_system_grn').select('*')
      .in('po_number', chunk).lte('received_on', today).order('grn_detail_id'));
    receipts.push(...rows.filter(row => productKeys.has(JSON.stringify([row.po_number, row.product_code]))));
  }
  // Also inspect references retained after a source/line change to flag drift.
  const loaded = new Set(receipts.map(r => r.grn_detail_id));
  const extra = [...new Set(reconciliations.filter(r => !r.reversed_at).map(r => r.grn_detail_id))].filter(id => !loaded.has(id));
  for (let i = 0; i < extra.length; i += 100) {
    const chunk = extra.slice(i, i + 100);
    receipts.push(...await pageAll<SystemGrn>(() => db.from('sd_inward_v2_system_grn').select('*')
      .in('grn_detail_id', chunk).lte('received_on', today).order('grn_detail_id')));
  }
  return { plans, lines, reports, reconciliations, receipts };
}
