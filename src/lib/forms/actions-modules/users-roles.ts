'use server';

import { randomBytes } from 'crypto';
import { revalidatePath } from 'next/cache';
import { createClient, hasSupabaseEnv } from '@/lib/supabase/server';
import { createAdminClient, hasSupabaseAdminEnv } from '@/lib/supabase/admin';
import { createPublicClient } from '@/lib/supabase/public';
import { computeClosureCompliance } from '@/lib/business-logic';
import { recomputeExpectedCost } from '@/lib/standard-cost';
import { currentUser, loadApprovedStandardCosts, loadApprovedMaterialCosts } from '../queries';
import { canApprove, canEdit, canSubmit, statusOnSubmit } from '../approval';
import {
  canAcceptProposal,
  canConfirmCm,
  canConfirmFabric,
  canPropose,
  canRejectCost,
  canRenegotiate,
  canSetTarget,
  canSignOff,
  canSubmitRate,
} from '../cost';
import type { ApprovalEntity, PoCategory, PoType, SdRole, SdStatus } from '../types';
import { INWARD_PLAN_STATUSES } from '../types';
import {
  type ActionResult,
  type LinkResult,
  fail,
  done,
  supa,
  writeLog,
  recordCommitment,
  numOrNull,
  dateOrNull,
  textOrNull,
} from './_shared';

const ASSIGNABLE_ROLES: SdRole[] = ['viewer', 'team', 'admin'];

export async function saveUser(formData: FormData): Promise<ActionResult> {
  const actor = await currentUser();
  if (!actor) return fail('Not signed in.');
  if (actor.role !== 'admin') return fail('Only an admin can manage users.');

  const email = String(formData.get('email') ?? '').trim().toLowerCase();
  const fullName = String(formData.get('full_name') ?? '').trim() || null;
  const role = String(formData.get('role') ?? '') as SdRole;
  const isActive = formData.get('is_active') === 'true';

  if (!/^[^@\s]+@saadaa\.in$/.test(email)) {
    return fail('Enter a valid @saadaa.in email address.');
  }
  if (!ASSIGNABLE_ROLES.includes(role)) return fail('Invalid role.');
  // Guard against locking yourself out of the role manager.
  if (email === actor.email && (role !== 'admin' || !isActive)) {
    return fail('You cannot remove your own admin access.');
  }

  const supabase = await supa();
  const { error } = await supabase
    .from('sd_user')
    .upsert(
      { email, full_name: fullName, role, is_active: isActive },
      { onConflict: 'email' },
    );
  if (error) return fail(`Could not save user: ${error.message}`);

  revalidatePath('/users');
  return done(`Saved ${email}.`);
}

/* ------------------------------------------------------------------ */
/* Custom roles (User Panel — named view sets, multi-role per user)    */
/* ------------------------------------------------------------------ */

/** Create or update a custom role (name, description, view set). Admin-only. */
export async function saveCustomRole(formData: FormData): Promise<ActionResult> {
  const actor = await currentUser();
  if (!actor) return fail('Not signed in.');
  if (actor.role !== 'admin') return fail('Only an admin can manage roles.');

  const id = Number(formData.get('id')) || null;
  const name = String(formData.get('name') ?? '').trim();
  const description = String(formData.get('description') ?? '').trim() || null;
  let pages: string[];
  try {
    pages = JSON.parse(String(formData.get('pages') ?? '[]'));
  } catch {
    return fail('Invalid view list.');
  }
  if (!name) return fail('Give the role a name.');
  if (!Array.isArray(pages)) return fail('Invalid view list.');

  const supabase = await supa();
  const { error } = id
    ? await supabase.from('sd_custom_role').update({ name, description, pages }).eq('id', id)
    : await supabase.from('sd_custom_role').insert({ name, description, pages });
  if (error) {
    return fail(
      error.message.includes('duplicate')
        ? `A role named "${name}" already exists.`
        : `Could not save role: ${error.message}`,
    );
  }
  revalidatePath('/users');
  return done(id ? `Updated role "${name}".` : `Created role "${name}".`);
}

/** Delete a custom role; its assignments cascade away. Admin-only. */
export async function deleteCustomRole(formData: FormData): Promise<ActionResult> {
  const actor = await currentUser();
  if (!actor) return fail('Not signed in.');
  if (actor.role !== 'admin') return fail('Only an admin can manage roles.');
  const id = Number(formData.get('id'));
  if (!id) return fail('Invalid role.');
  const supabase = await supa();
  const { error } = await supabase.from('sd_custom_role').delete().eq('id', id);
  if (error) return fail(`Could not delete role: ${error.message}`);
  revalidatePath('/users');
  return done('Role deleted.');
}

/** Replace a user's custom-role set (a person can hold several). Admin-only. */
export async function setUserRoles(formData: FormData): Promise<ActionResult> {
  const actor = await currentUser();
  if (!actor) return fail('Not signed in.');
  if (actor.role !== 'admin') return fail('Only an admin can manage roles.');

  const email = String(formData.get('email') ?? '').trim().toLowerCase();
  let roleIds: number[];
  try {
    roleIds = JSON.parse(String(formData.get('role_ids') ?? '[]'));
  } catch {
    return fail('Invalid role list.');
  }
  if (!email || !Array.isArray(roleIds)) return fail('Invalid request.');

  const supabase = await supa();
  // Full replace: delete then re-insert the set (small N, admin-gated).
  const { error: delErr } = await supabase.from('sd_user_role').delete().eq('user_email', email);
  if (delErr) return fail(`Could not update roles: ${delErr.message}`);
  if (roleIds.length) {
    const { error: insErr } = await supabase
      .from('sd_user_role')
      .insert(roleIds.map((role_id) => ({ user_email: email, role_id })));
    if (insErr) return fail(`Could not update roles: ${insErr.message}`);
  }
  revalidatePath('/users');
  return done(`Updated roles for ${email}.`);
}

/**
 * Create (or reset) an email+password login for a user, then provision their
 * role. Admin-only. Uses the service-role Admin API (the publishable key cannot
 * create auth users); the sd_user role row is still written with the actor's
 * JWT so RLS applies. Domain is enforced here since the auth.users trigger is
 * absent on this project.
 */
export async function createUserLogin(formData: FormData): Promise<ActionResult> {
  const actor = await currentUser();
  if (!actor) return fail('Not signed in.');
  if (actor.role !== 'admin') return fail('Only an admin can manage users.');

  const email = String(formData.get('email') ?? '').trim().toLowerCase();
  const fullName = String(formData.get('full_name') ?? '').trim() || null;
  const role = String(formData.get('role') ?? '') as SdRole;
  const isActive = formData.get('is_active') === 'true';
  const password = String(formData.get('password') ?? '');

  if (!/^[^@\s]+@saadaa\.in$/.test(email)) return fail('Enter a valid @saadaa.in email address.');
  if (!ASSIGNABLE_ROLES.includes(role)) return fail('Invalid role.');
  if (password.length < 8) return fail('Password must be at least 8 characters.');
  if (!hasSupabaseAdminEnv()) {
    return fail('SUPABASE_SERVICE_ROLE_KEY is not set on the server, so login accounts cannot be created.');
  }

  const admin = createAdminClient();
  // Pre-confirm the email so the user can sign in immediately with the password.
  const { error: createErr } = await admin.auth.admin.createUser({
    email,
    password,
    email_confirm: true,
    user_metadata: fullName ? { full_name: fullName } : undefined,
  });
  if (createErr) {
    // Already registered -> treat as a password reset for the existing account.
    const existing = await findAuthUserByEmail(email);
    if (!existing) return fail(`Could not create login: ${createErr.message}`);
    const { error: updErr } = await admin.auth.admin.updateUserById(existing.id, { password });
    if (updErr) return fail(`Could not set password: ${updErr.message}`);
  }

  // Provision/refresh the role row with the actor's JWT (RLS: admin manage users).
  const supabase = await supa();
  const { error: roleErr } = await supabase
    .from('sd_user')
    .upsert({ email, full_name: fullName, role, is_active: isActive }, { onConflict: 'email' });
  if (roleErr) return fail(`Login created, but saving the role failed: ${roleErr.message}`);

  revalidatePath('/users');
  return done(`${createErr ? 'Reset password for' : 'Created login for'} ${email}.`);
}

// Find an existing auth user by email (paginated; the user base is small).
async function findAuthUserByEmail(email: string) {
  const admin = createAdminClient();
  const target = email.toLowerCase();
  for (let page = 1; ; page += 1) {
    const { data, error } = await admin.auth.admin.listUsers({ page, perPage: 1000 });
    const users = data?.users ?? [];
    if (error || !users.length) return null;
    const found = users.find((u) => (u.email ?? '').toLowerCase() === target);
    if (found) return found;
    if (users.length < 1000) return null;
  }
}

/* ------------------------------------------------------------------ */
/* OOS Calculation — team-managed SKU exclusion list                   */
/* ------------------------------------------------------------------ */

/** Team/admin: exclude a SKU from the OOS Calculation view. */
