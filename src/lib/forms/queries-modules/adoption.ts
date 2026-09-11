import 'server-only';
import { client, PAGE_SIZE } from './_shared';

/* Adoption & Activity (admin) — who is using the dashboard and whether entries are happening.
   Login/usage comes from sd_user.last_seen_at (stamped on every page load); cross-module
   activity comes from the unified sd_approval_log (actor_email + entity_type + created_at). */

export type AdoptionUser = {
  email: string;
  full_name: string | null;
  role: string;
  is_active: boolean;
  last_seen_at: string | null;
  days_since: number | null; // days since last seen (null = never)
  actions_7d: number;
  actions_30d: number;
  last_action_at: string | null;
};

export type AdoptionModule = { key: string; label: string; entries_7d: number; entries_30d: number };

export type AdoptionData = {
  users: AdoptionUser[];
  modules: AdoptionModule[];
  generatedAt: string;
};

const MODULE_LABEL: Record<string, string> = {
  standard_cost: 'Standard Cost',
  material_cost: 'Material Cost',
  po_approval: 'PO Approval',
  buying_plan: 'Buying Plan',
  po_closure: 'PO Closure',
  cutting_register: 'Cutting Register',
  feedback: 'Feedback',
  receivable: 'Receivable',
  vendor_capacity: 'Vendor Capacity',
  product_master: 'Product Master',
  inward_plan: 'Inward Plan',
};
const labelOf = (k: string) => MODULE_LABEL[k] ?? k.replace(/_/g, ' ');

export async function loadAdoption(): Promise<AdoptionData> {
  const supabase = await client();
  const now = Date.now();
  const iso7 = new Date(now - 7 * 86_400_000).toISOString();
  const iso30 = new Date(now - 30 * 86_400_000).toISOString();

  // Users (login/usage).
  const { data: uData } = await supabase
    .from('sd_user')
    .select('email, full_name, role, is_active, last_seen_at')
    .order('email');
  const users = (uData ?? []) as {
    email: string; full_name: string | null; role: string; is_active: boolean; last_seen_at: string | null;
  }[];

  // Unified activity log for the last 30 days (paged).
  const logs: { actor_email: string | null; entity_type: string | null; created_at: string }[] = [];
  for (let from = 0; ; from += PAGE_SIZE) {
    const { data } = await supabase
      .from('sd_approval_log')
      .select('actor_email, entity_type, created_at')
      .gte('created_at', iso30)
      .order('created_at', { ascending: false })
      .range(from, from + PAGE_SIZE - 1);
    if (!data?.length) break;
    logs.push(...(data as typeof logs));
    if (data.length < PAGE_SIZE) break;
  }

  // Aggregate per user and per module from the log.
  const byUser = new Map<string, { a7: number; a30: number; last: string | null }>();
  const byModule = new Map<string, { e7: number; e30: number }>();
  for (const l of logs) {
    const within7 = l.created_at >= iso7;
    const em = (l.actor_email ?? '').toLowerCase();
    if (em) {
      const u = byUser.get(em) ?? { a7: 0, a30: 0, last: null };
      u.a30 += 1;
      if (within7) u.a7 += 1;
      if (!u.last || l.created_at > u.last) u.last = l.created_at;
      byUser.set(em, u);
    }
    const mod = l.entity_type ?? 'other';
    const m = byModule.get(mod) ?? { e7: 0, e30: 0 };
    m.e30 += 1;
    if (within7) m.e7 += 1;
    byModule.set(mod, m);
  }

  const usersOut: AdoptionUser[] = users.map((u) => {
    const a = byUser.get(u.email.toLowerCase());
    const days = u.last_seen_at ? Math.floor((now - Date.parse(u.last_seen_at)) / 86_400_000) : null;
    return {
      email: u.email,
      full_name: u.full_name,
      role: u.role,
      is_active: u.is_active,
      last_seen_at: u.last_seen_at,
      days_since: days,
      actions_7d: a?.a7 ?? 0,
      actions_30d: a?.a30 ?? 0,
      last_action_at: a?.last ?? null,
    };
  });

  // Module entries: workflow modules from the log + tables that don't log (cutting register).
  const modulesOut: AdoptionModule[] = [...byModule.entries()].map(([key, v]) => ({
    key, label: labelOf(key), entries_7d: v.e7, entries_30d: v.e30,
  }));

  // Cutting register inserts aren't in the approval log — count them directly.
  const headCount = async (table: string, col: string, sinceIso: string) => {
    const { count } = await supabase.from(table).select('*', { count: 'exact', head: true }).gte(col, sinceIso);
    return count ?? 0;
  };
  modulesOut.push({
    key: 'cutting_register',
    label: 'Cutting Register',
    entries_7d: await headCount('sd_cutting_register', 'created_at', iso7),
    entries_30d: await headCount('sd_cutting_register', 'created_at', iso30),
  });

  modulesOut.sort((a, b) => b.entries_30d - a.entries_30d || a.label.localeCompare(b.label));

  return { users: usersOut, modules: modulesOut, generatedAt: new Date().toISOString() };
}
