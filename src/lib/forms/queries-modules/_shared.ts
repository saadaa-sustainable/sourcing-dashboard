import 'server-only';
import { createClient, hasSupabaseEnv } from '@/lib/supabase/server';

/**
 * Reads for the write-side tables.
 *
 * PostgREST caps a response at 1000 rows, so anything that can grow past that
 * pages explicitly — same reason `fetchAllRows` exists in lib/data.ts.
 */
export const PAGE_SIZE = 1000;

export class NotConfiguredError extends Error {
  constructor() {
    super(
      'Supabase is not configured. Workflow forms cannot run against local fixtures — set NEXT_PUBLIC_SUPABASE_URL and NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY.',
    );
    this.name = 'NotConfiguredError';
  }
}

export async function client() {
  if (!hasSupabaseEnv()) throw new NotConfiguredError();
  return createClient();
}
