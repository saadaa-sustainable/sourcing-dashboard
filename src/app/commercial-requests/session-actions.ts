'use server';
import { redirect } from 'next/navigation';
import { createSessionClient, hasSupabaseEnv } from '@/lib/supabase/server';
import { commercialIdentity } from '@/lib/commercial-access.server';
import { createAdminClient } from '@/lib/supabase/admin';

export async function vendorCommercialLogin(fd: FormData) {
  if (!hasSupabaseEnv()) redirect('/commercial-requests/login?error=Commercial+Requests+is+not+configured.');
  const session = await createSessionClient();
  const { error } = await session.auth.signInWithPassword({ email: String(fd.get('email') ?? '').trim().toLowerCase(), password: String(fd.get('password') ?? '') });
  if (error) redirect('/commercial-requests/login?error=Unable+to+sign+in.+Check+your+credentials.');
  let actor = null;
  try { actor = await commercialIdentity(); } catch { /* Fail closed if provisioning is unavailable. */ }
  if (!actor) {
    await session.auth.signOut();
    redirect('/commercial-requests/login?error=Your+account+does+not+have+active+commercial+access.+Contact+SAADAA.');
  }
  redirect(actor.passwordChangeRequired ? '/commercial-requests/change-password' : actor.vendorCode ? '/commercial-requests' : '/vendor-commercial');
}

export async function changeVendorTemporaryPassword(fd: FormData): Promise<{ ok: false; error: string }> {
  const actor = await commercialIdentity();
  if (!actor?.vendorCode || !actor.passwordChangeRequired) return { ok: false, error: 'Sign in with your temporary password first.' };
  const current = String(fd.get('current_password') ?? '');
  const password = String(fd.get('new_password') ?? '');
  const confirm = String(fd.get('confirm_password') ?? '');
  if (!current) return { ok: false, error: 'Enter your current temporary password.' };
  if (password.length < 12 || password.length > 128) return { ok: false, error: 'Use a new password between 12 and 128 characters.' };
  if (password !== confirm) return { ok: false, error: 'The new passwords do not match.' };
  if (password === current) return { ok: false, error: 'Choose a password different from your temporary password.' };
  const session = await createSessionClient();
  const { error: verifyError } = await session.auth.signInWithPassword({ email: actor.email, password: current });
  if (verifyError) return { ok: false, error: 'Your current password is incorrect. Please retry.' };
  const { error: passwordError } = await session.auth.updateUser({ password });
  if (passwordError) return { ok: false, error: 'Could not update the password. Check the password requirements and retry.' };
  // The vendor cannot edit app_metadata. Clear this server-controlled gate only after Auth accepts the new password.
  const { error: flagError } = await createAdminClient().auth.admin.updateUserById(actor.uid, { app_metadata: { commercial_password_change_required: false } });
  if (flagError) return { ok: false, error: 'Your password changed, but access could not be unlocked. Use your new password as the current password to retry, or contact SAADAA.' };
  // Re-login obtains a fresh JWT with the cleared flag; older temporary-password tokens remain blocked by RLS.
  await session.auth.signOut();
  redirect('/commercial-requests/login?message=Password+updated.+Sign+in+with+your+new+password.');
}
export async function vendorCommercialSignOut() {
  const session = await createSessionClient();
  await session.auth.signOut();
  redirect('/commercial-requests/login');
}
