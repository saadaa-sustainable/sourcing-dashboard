import { createClient as createSupabaseClient } from '@supabase/supabase-js';

// Admin client — uses the service-role key and therefore BYPASSES RLS. It must
// only ever be constructed inside server code (server actions / server
// components). The key is read from a server-only variable and must never be
// exposed through a NEXT_PUBLIC_ variable or shipped to the browser.
export function hasSupabaseAdminEnv() {
  return Boolean(process.env.NEXT_PUBLIC_SUPABASE_URL && process.env.SUPABASE_SERVICE_ROLE_KEY);
}

export function createAdminClient() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) throw new Error('Supabase service-role environment variables are not configured.');
  return createSupabaseClient(url, key, {
    auth: { autoRefreshToken: false, persistSession: false },
  });
}
