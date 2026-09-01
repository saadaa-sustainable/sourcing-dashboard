'use server';

import { redirect } from 'next/navigation';
import { createClient, hasSupabaseEnv } from '@/lib/supabase/server';

export async function login(formData: FormData) {
  const email = String(formData.get('email') ?? '').trim().toLowerCase();
  const password = String(formData.get('password') ?? '');
  if (!email.endsWith('@saadaa.in')) redirect('/login?error=Use+your+%40saadaa.in+email+address.');
  if (!hasSupabaseEnv()) redirect('/my-dashboard');
  const supabase = await createClient();
  const { error } = await supabase.auth.signInWithPassword({ email, password });
  if (error) redirect(`/login?error=${encodeURIComponent(error.message)}`);
  // Land on the role-specific My Dashboard; the Main Dashboard stays at '/'.
  redirect('/my-dashboard');
}
