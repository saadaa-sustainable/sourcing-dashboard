import 'server-only';
import { createAdminClient, hasSupabaseAdminEnv } from '@/lib/supabase/admin';
import { currentUser } from '@/lib/forms/queries';
import { pageAll } from '@/lib/forms/queries-modules/_shared';
import type { CostRevision, CostSnapshot, CostWorkflowEvent } from './standard-cost-workflow';

export type MaterialCostWorkflowEvent = {
  id: number;
  material_code: string;
  event: string;
  actor: string;
  reason: string;
  created_at: string;
};

export async function costWorkflowUser(write = false) {
  const user = await currentUser();
  if (!user || !user.is_active || (user.allowed_pages !== null && user.allowed_pages !== undefined && !user.allowed_pages.includes('/standard-cost'))) throw new Error('Standard Cost access is required.');
  if (write && user.role !== 'team' && user.role !== 'admin') throw new Error('Only team and admin users can submit costs.');
  return user;
}

export async function costSnapshot(code: string): Promise<CostSnapshot> {
  await costWorkflowUser();
  const { data, error } = await createAdminClient().rpc('sd_cost_snapshot', { p_code: code });
  if (error) throw new Error(error.message);
  if (!data) throw new Error('Cost record not found.');
  return data as CostSnapshot;
}

export async function loadCostWorkflow(code?: string): Promise<{ ready: boolean; revisions: CostRevision[]; events: CostWorkflowEvent[]; error?: string }> {
  const user = await costWorkflowUser();
  if (!hasSupabaseAdminEnv()) return { ready: false, revisions: [], events: [], error: 'Standard Cost workflow storage is not configured.' };
  const db = createAdminClient();
  try {
    const [revisions, events] = await Promise.all([
      pageAll<CostRevision>(() => {
        let q = db.from('sd_cost_revision').select('*').order('id', { ascending: false });
        if (code) q = q.eq('product_code', code);
        return q;
      }),
      !code && user.role !== 'admin' ? Promise.resolve([] as CostWorkflowEvent[]) : pageAll<CostWorkflowEvent>(() => {
        let q = db.from('sd_cost_revision_event').select('*').order('id', { ascending: false });
        if (code) q = q.eq('product_code', code);
        return q;
      }),
    ]);
    return { ready: true, revisions, events };
  } catch (error) {
    return { ready: false, revisions: [], events: [], error: `Standard Cost workflows are unavailable: ${error instanceof Error ? error.message : 'database read failed'}` };
  }
}

/** Material costs use the established approval audit trail instead of FG revisions. */
export async function loadMaterialCostWorkflow(costs: { id: number; product_code: string }[]): Promise<{ ready: boolean; events: MaterialCostWorkflowEvent[]; error?: string }> {
  const user = await costWorkflowUser();
  if (user.role !== 'admin') return { ready: true, events: [] };
  if (!hasSupabaseAdminEnv()) return { ready: false, events: [], error: 'Standard Cost workflow storage is not configured.' };
  const codeById = new Map(costs.map(cost => [String(cost.id), cost.product_code]));
  try {
    const rows = await pageAll<{ id: number; entity_id: string; actor_email: string; notes: string | null; to_status: string; created_at: string }>(() => createAdminClient()
      .from('sd_approval_log')
      .select('id, entity_id, actor_email, notes, to_status, created_at')
      .eq('entity_type', 'material_cost')
      .order('id', { ascending: false }));
    const eventName = (notes: string | null, status: string) => {
      const value = (notes ?? '').toLowerCase();
      if (value.startsWith('target ')) return 'set target';
      if (value.includes('rejected')) return 'reject';
      if (value.includes('renegotiate')) return 'rework';
      if (value.includes('approved') || value.includes('accepted')) return 'approve';
      if (value.includes('proposed') || value.includes('actual rate')) return 'submit';
      return status.replaceAll('_', ' ');
    };
    return { ready: true, events: rows.map(row => ({
      id: row.id,
      material_code: codeById.get(row.entity_id) ?? '',
      event: eventName(row.notes, row.to_status),
      actor: row.actor_email,
      reason: row.notes ?? '',
      created_at: row.created_at,
    })).filter(event => Boolean(event.material_code)) };
  } catch (error) {
    return { ready: false, events: [], error: `Material Cost workflows are unavailable: ${error instanceof Error ? error.message : 'database read failed'}` };
  }
}
