import 'server-only';
import { cache } from 'react';
import { createSessionClient } from '@/lib/supabase/server';
import { pageAll } from '@/lib/forms/queries-modules/_shared';
import { canView } from '@/lib/views';
import { units } from './analytics';
import { MAIN_WAREHOUSE } from '@/lib/po-scope';
import type { SdRole } from '@/lib/forms/types';
import type { Plan, PlanLine, HistoryEntry, SourceLine, InventorySize, ProductSource } from './types';

export class V2SignInRequired extends Error {}
export const context = cache(async () => {
  const db = await createSessionClient();
  const { data: { user }, error } = await db.auth.getUser();
  if (error || !user?.email) throw new V2SignInRequired('Sign in to access Inward Plan V2.');
  const email = user.email.toLowerCase();
  if (!email.endsWith('@saadaa.in')) throw new Error('A SAADAA account is required.');
  const [{ data: account, error: accountError }, assignments] = await Promise.all([
    db.from('sd_user').select('email,role,is_active').eq('email', email).maybeSingle(),
    pageAll<{ sd_custom_role: { pages: string[] } | null }>(() => db.from('sd_user_role')
      .select('role_id,sd_custom_role(pages)').eq('user_email', email).order('role_id')),
  ]);
  if (accountError) throw new Error(accountError.message);
  if (!account?.is_active || !['viewer', 'team', 'admin'].includes(account.role))
    throw new Error('An active, provisioned dashboard account is required.');
  const role = account.role as SdRole;
  const allowedPages = assignments.length ? [...new Set(assignments.flatMap(r => r.sd_custom_role?.pages ?? []))] : null;
  if (!canView('/inward-plan-v2', role, allowedPages)) throw new Error('Your roles do not grant Inward Plan V2 access.');
  return { db, email, role, allowedPages };
});

export async function loadPlans() {
  const { db } = await context();
  return pageAll<Plan>(() => db.from('sd_inward_plan_v2').select('*')
    .order('period_start', { ascending: false }).order('id'));
}
export async function loadPlan(id: string) {
  const { db } = await context();
  const [{ data: plan, error }, lines, history] = await Promise.all([
    db.from('sd_inward_plan_v2').select('*').eq('id', id).maybeSingle(),
    pageAll<PlanLine>(() => db.from('sd_inward_plan_v2_line').select('*').eq('plan_id', id).order('expected_date').order('id')),
    pageAll<HistoryEntry>(() => db.from('sd_inward_plan_v2_approval_history').select('*').eq('plan_id', id)
      .order('changed_at', { ascending: false }).order('id', { ascending: false })),
  ]);
  if (error) throw new Error(error.message);
  return { plan: plan as Plan | null, lines, history };
}
export async function findSources(query = '', field: 'product' | 'variant' = 'product') {
  const { db } = await context();
  const cleaned = query.trim();
  if (cleaned.length > 80 || /[^a-zA-Z0-9 _/.-]/.test(cleaned)) throw new Error('Search with letters, numbers, spaces, /, -, _ or dots (up to 80 characters).');
  const sources = await pageAll<SourceLine>(() => {
    let request = db.from('sd_po_filtered')
      .select('po_detail_id,po_number,po_ref_num,product_code,product_variant,sku,size,vendor_name,pending_qty,item_price,expected_delivery_date')
      .eq('po_status', 'Approved').gt('pending_qty', 0).not('product_code', 'is', null);
    if (cleaned) request = request.ilike(field === 'variant' ? 'product_variant' : 'product_code', '%' + cleaned.replace(/[_%]/g, '\\$&') + '%');
    return request.order('product_code').order('product_variant').order('po_detail_id');
  });
  const variants = [...new Set(sources.map(row => row.product_variant).filter((v): v is string => !!v))];
  const byVariant = new Map<string, InventorySize[]>();
  for (let i = 0; i < variants.length; i += 50) {
    const chunk = variants.slice(i, i + 50);
    const inventory = await pageAll<InventorySize & { product_variant: string }>(() =>
      db.from('sd_inventory_planning').select('sku,size,product_variant,current_stock,doq_45')
        .eq('warehouse', MAIN_WAREHOUSE).in('product_variant', chunk).order('row_key'));
    for (const row of inventory) {
      const rows = byVariant.get(row.product_variant) ?? [];
      rows.push(row);
      byVariant.set(row.product_variant, rows);
    }
  }
  return sources.map(source => ({ ...source, inventory: byVariant.get(source.product_variant ?? '') ?? [] }));
}
export async function validationErrors(id: string) {
  const { db } = await context();
  const { plan, lines } = await loadPlan(id);
  if (!plan) throw new Error('Plan not found.');
  const errors: string[] = [];
  if (!lines.length) errors.push('Add at least one PO/product line.');
  const totals = new Map<string, number>();
  for (const line of lines) {
    if (line.planning_level !== 'product' && line.po_detail_id) totals.set(line.po_detail_id, (totals.get(line.po_detail_id) ?? 0) + units(line.inward_qty));
    if (line.expected_date < plan.period_start || line.expected_date > plan.period_end)
      errors.push(line.product_code + ': receipt date is outside the planning period.');
  }
  const ids = [...totals.keys()];
  for (let i = 0; i < ids.length; i += 100) {
    const chunk = ids.slice(i, i + 100);
    const sources = await pageAll<SourceLine & { po_status: string }>(() => db.from('sd_po_filtered')
      .select('po_detail_id,sku,size,po_number,pending_qty,po_status').in('po_detail_id', chunk).order('po_detail_id'));
    const byId = new Map(sources.map(s => [s.po_detail_id, s]));
    for (const line of lines.filter(l => !!l.po_detail_id && chunk.includes(l.po_detail_id))) {
      const source = byId.get(line.po_detail_id!);
      if (!source || source.po_status !== 'Approved' || Number(source.pending_qty) <= 0 ||
        source.sku !== line.sku || source.po_number !== line.po_number || source.size !== line.size)
        errors.push(line.sku + ': PO/SKU is no longer available, approved and open.');
    }
    for (const source of sources) if ((totals.get(source.po_detail_id) ?? 0) > Number(source.pending_qty) * 1000)
      errors.push(source.sku + ': scheduled total exceeds pending PO quantity (' + source.pending_qty + ').');
  }
  const productLines = lines.filter(line => line.planning_level === 'product');
  const pos = [...new Set(productLines.map(line => line.po_number))];
  for (let i = 0; i < pos.length; i += 50) {
    const chunk = pos.slice(i, i + 50);
    const sources = await pageAll<ProductSource>(() => db.from('sd_inward_v2_product_po').select('*').in('po_number', chunk).order('po_number').order('product_code'));
    for (const line of productLines.filter(line => chunk.includes(line.po_number))) {
      const source = sources.find(row => row.po_number === line.po_number && row.product_code === line.product_code);
      const total = productLines.filter(row => row.po_number === line.po_number && row.product_code === line.product_code).reduce((sum, row) => sum + units(row.inward_qty), 0);
      if (!source) errors.push(line.product_code + ': PO/product is no longer approved and open.');
      else if (total > units(source.pending_qty)) errors.push(line.product_code + ': total exceeds pending PO/product quantity (' + source.pending_qty + ').');
    }
  }
  if (Date.now() >= new Date(plan.submission_deadline).getTime() && plan.status !== 'pending_l2' && plan.status !== 'approved')
    errors.push('Submission deadline has passed. Move the plan to a future period before submitting.');
  return [...new Set(errors)];
}

export async function loadBoardLines(planIds: string[]) {
  const { db } = await context();
  const lines: import('./plan-board').BoardLine[] = [];
  for (let i = 0; i < planIds.length; i += 100) {
    const chunk = planIds.slice(i, i + 100);
    lines.push(...await pageAll<import('./plan-board').BoardLine>(() => db.from('sd_inward_plan_v2_line')
      .select('plan_id,product_code,inward_qty,cost_per_piece').in('plan_id', chunk).order('id')));
  }
  return lines;
}
