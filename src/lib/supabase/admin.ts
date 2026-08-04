import { createClient as createSupabaseClient } from '@supabase/supabase-js';

// Service-role client — BYPASSES RLS. Server-only. Used solely for Supabase Auth
// Admin operations (creating login accounts / setting passwords), which the
// publishable key cannot do. The key is read from a server-only variable and
// must never be exposed through a NEXT_PUBLIC_ variable or sent to the browser.
export function hasSupabaseAdminEnv() {
  return Boolean(process.env.NEXT_PUBLIC_SUPABASE_URL && process.env.SUPABASE_SERVICE_ROLE_KEY);
}

export function createAdminClient() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) throw new Error('SUPABASE_SERVICE_ROLE_KEY is not configured.');
  return createSupabaseClient(url, key, {
    auth: { autoRefreshToken: false, persistSession: false },
  });
}
