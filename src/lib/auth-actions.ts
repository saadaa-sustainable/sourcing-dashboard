'use server';

import { redirect } from 'next/navigation';
import { createSessionClient, hasSupabaseEnv } from '@/lib/supabase/server';

/** Shared sign-out, used by the dashboard and every workflow page's sidebar. */
export async function signOut() {
  if (hasSupabaseEnv()) {
    const supabase = await createSessionClient();
    await supabase.auth.signOut();
  }
  redirect('/login');
}
