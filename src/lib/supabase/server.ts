import { createServerClient } from '@supabase/ssr';
import { cookies } from 'next/headers';

export function hasSupabaseEnv() {
  return Boolean(process.env.NEXT_PUBLIC_SUPABASE_URL && process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY);
}

/**
 * Fixture mode (no Supabase env → no auth, admin nav) is a LOCAL-DEV convenience
 * ONLY. In a real deployment (NODE_ENV === 'production' — Vercel prod AND preview)
 * a missing env is a misconfiguration (dropped var, botched rename) that must
 * FAIL CLOSED: never silently serve a no-login admin dashboard. Call this at every
 * auth entry point that would otherwise fall back to fixture mode.
 *
 * Returns true when fixture mode is genuinely allowed (dev + env absent);
 * returns false when Supabase is configured (real auth must run);
 * THROWS when env is absent in production.
 */
export function isFixtureMode(): boolean {
  if (hasSupabaseEnv()) return false;
  if (process.env.NODE_ENV === 'production') {
    throw new Error(
      'Supabase environment is not configured (NEXT_PUBLIC_SUPABASE_URL / ' +
        'NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY). Refusing to serve a no-login admin ' +
        'dashboard in production — set the environment variables.',
    );
  }
  return true;
}

export async function createClient() {
  const cookieStore = await cookies();
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY;
  if (!url || !key) throw new Error('Supabase environment variables are not configured.');
  return createServerClient(url, key, {
    cookies: {
      getAll: () => cookieStore.getAll(),
      setAll: (cookiesToSet) => {
        try { cookiesToSet.forEach(({ name, value, options }) => cookieStore.set(name, value, options)); }
        catch { /* Server Components cannot write; proxy refreshes the session. */ }
      },
    },
  });
}
