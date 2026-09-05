import 'server-only';
import { client } from './_shared';
import type { SdUser, SdCustomRole } from '../types';

/* ------------------------------------------------------------------ */
/* Identity                                                            */
/* ------------------------------------------------------------------ */

export async function currentUser(): Promise<SdUser | null> {
  const supabase = await client();
  const { data: claims } = await supabase.auth.getClaims();
  const email =
    typeof claims?.claims?.email === 'string'
      ? claims.claims.email.toLowerCase()
      : null;
  if (!email) return null;

  const { data } = await supabase
    .from('sd_user')
    .select('email, full_name, role, is_active')
    .eq('email', email)
    .maybeSingle();

  // Best-effort: stamp last-seen so the User Panel can show when each person last used
  // the dashboard. The RPC is throttled server-side (~5-min granularity) and scoped to
  // the caller's own row; never let it block or break auth.
  try {
    await supabase.rpc('sd_touch_last_seen');
  } catch {
    /* ignore — presence tracking must never fail a page load */
  }

  // Someone signed in with a valid @saadaa.in account but was never added to
  // sd_user. Treat as viewer rather than crashing — an admin adds them later.
  const user: SdUser = (data as SdUser | null) ?? {
    email,
    full_name: null,
    role: 'viewer',
    is_active: true,
  };

  // View access: union of pages across the user's custom roles (User Panel).
  // Admins and users with no custom roles are unrestricted (null).
  user.allowed_pages = null;
  if (user.role !== 'admin') {
    const { data: assignments } = await supabase
      .from('sd_user_role')
      .select('role_id, sd_custom_role(pages)')
      .eq('user_email', user.email);
    const rows = (assignments ?? []) as unknown as { role_id: number; sd_custom_role: { pages: string[] | null } | null }[];
    if (rows.length) {
      user.custom_role_ids = rows.map((r) => r.role_id);
      user.allowed_pages = [...new Set(rows.flatMap((r) => r.sd_custom_role?.pages ?? []))];
    }
  }
  return user;
}

/** All custom roles with their member emails, for the User Panel. */
export async function loadCustomRoles(): Promise<SdCustomRole[]> {
  const supabase = await client();
  const [{ data: roles }, { data: assignments }] = await Promise.all([
    supabase.from('sd_custom_role').select('id, name, description, pages').order('name'),
    supabase.from('sd_user_role').select('user_email, role_id'),
  ]);
  const members = new Map<number, string[]>();
  ((assignments ?? []) as { user_email: string; role_id: number }[]).forEach((a) => {
    members.set(a.role_id, [...(members.get(a.role_id) ?? []), a.user_email]);
  });
  return ((roles ?? []) as SdCustomRole[]).map((r) => ({
    ...r,
    pages: r.pages ?? [],
    members: members.get(r.id) ?? [],
  }));
}

/** Every provisioned user, for the admin-only User Panel. */
export async function loadUsers(): Promise<SdUser[]> {
  const supabase = await client();
  const [{ data }, { data: assignments }] = await Promise.all([
    supabase
      .from('sd_user')
      .select('email, full_name, role, is_active, last_seen_at')
      .order('is_active', { ascending: false })
      .order('email'),
    supabase.from('sd_user_role').select('user_email, role_id'),
  ]);
  const byEmail = new Map<string, number[]>();
  ((assignments ?? []) as { user_email: string; role_id: number }[]).forEach((a) => {
    byEmail.set(a.user_email, [...(byEmail.get(a.user_email) ?? []), a.role_id]);
  });
  return ((data ?? []) as SdUser[]).map((u) => ({
    ...u,
    custom_role_ids: byEmail.get(u.email) ?? [],
  }));
}
