'use server';

import { redirect } from 'next/navigation';
import { createClient, hasSupabaseEnv } from '@/lib/supabase/server';

/** Shared sign-out, used by the dashboard and every workflow page's sidebar. */
export async function signOut() {
  if (hasSupabaseEnv()) {
    const supabase = await createClient();
    await supabase.auth.signOut();
  }
  redirect('/login');
}
