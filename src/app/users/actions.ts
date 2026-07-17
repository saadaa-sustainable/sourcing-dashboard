'use server';

import { revalidatePath } from 'next/cache';
import { headers } from 'next/headers';
import { redirect } from 'next/navigation';
import { createClient, hasSupabaseEnv } from '@/lib/supabase/server';
import { createAdminClient, hasSupabaseAdminEnv } from '@/lib/supabase/admin';

// Re-verify the caller server-side. Never trust the page guard alone: a server
// action is an independent POST endpoint that anyone with a session could hit.
async function requireUser() {
  const supabase = await createClient();
  const { data, error } = await supabase.auth.getClaims();
  if (error || !data?.claims) redirect('/login');
}

export async function inviteUser(formData: FormData) {
  if (!hasSupabaseEnv()) redirect('/');
  await requireUser();

  const email = String(formData.get('email') ?? '').trim().toLowerCase();
  if (!email) redirect('/users?error=Enter+an+email+address.');
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) redirect('/users?error=Enter+a+valid+email+address.');
  if (!hasSupabaseAdminEnv()) redirect('/users?error=SUPABASE_SERVICE_ROLE_KEY+is+not+configured+on+the+server.');

  const hdrs = await headers();
  const origin = hdrs.get('origin') ?? (hdrs.get('host') ? `https://${hdrs.get('host')}` : undefined);

  const admin = createAdminClient();
  const { error } = await admin.auth.admin.inviteUserByEmail(email, origin ? { redirectTo: `${origin}/login` } : undefined);
  if (error) redirect(`/users?error=${encodeURIComponent(error.message)}`);

  revalidatePath('/users');
  redirect(`/users?invited=${encodeURIComponent(email)}`);
}
