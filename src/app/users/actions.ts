'use server';

import { revalidatePath } from 'next/cache';
import { headers } from 'next/headers';
import { redirect } from 'next/navigation';
import { createClient, hasSupabaseEnv } from '@/lib/supabase/server';
import { createAdminClient, hasSupabaseAdminEnv } from '@/lib/supabase/admin';

// Re-verify the caller server-side. Never trust the page guard alone: a server
// action is an independent POST endpoint that anyone with a session could hit.
async function requireSaadaaUser() {
  const supabase = await createClient();
  const { data, error } = await supabase.auth.getClaims();
  if (error || !data?.claims) redirect('/login');
  const email = typeof data.claims.email === 'string' ? data.claims.email : '';
  if (!email.toLowerCase().endsWith('@saadaa.in')) redirect('/login?error=This+panel+is+restricted+to+SAADAA+accounts.');
  return email;
}

export async function inviteUser(formData: FormData) {
  if (!hasSupabaseEnv()) redirect('/');
  await requireSaadaaUser();

  const email = String(formData.get('email') ?? '').trim().toLowerCase();
  if (!email) redirect('/users?error=Enter+an+email+address.');
  if (!email.endsWith('@saadaa.in')) redirect('/users?error=Only+%40saadaa.in+addresses+can+be+invited.');
  if (!hasSupabaseAdminEnv()) redirect('/users?error=SUPABASE_SERVICE_ROLE_KEY+is+not+configured+on+the+server.');

  const hdrs = await headers();
  const origin = hdrs.get('origin') ?? (hdrs.get('host') ? `https://${hdrs.get('host')}` : undefined);

  const admin = createAdminClient();
  const { error } = await admin.auth.admin.inviteUserByEmail(email, origin ? { redirectTo: `${origin}/login` } : undefined);
  if (error) redirect(`/users?error=${encodeURIComponent(error.message)}`);

  revalidatePath('/users');
  redirect(`/users?invited=${encodeURIComponent(email)}`);
}
