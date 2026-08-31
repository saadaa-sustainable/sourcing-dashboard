import { createClient as createSupabaseClient } from '@supabase/supabase-js';

// Session-less anon client for the public /fill/[token] route. Runs as the `anon`
// Postgres role (no cookies, no login) and is used ONLY to call the granted
// SECURITY DEFINER RPCs (sd_validate_dynamic_link / sd_submit_cutting_register).
// It has no direct table access — RLS + the absence of anon table grants see to
// that. Uses the publishable (public) key, never the service-role key.
export function createPublicClient() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY;
  if (!url || !key) throw new Error('Supabase environment variables are not configured.');
  return createSupabaseClient(url, key, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
}
