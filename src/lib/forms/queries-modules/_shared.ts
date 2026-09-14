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

/**
 * Page through a PostgREST query until it runs dry. `build` must return a fresh
 * query each call (a builder can't be re-ranged), ordered deterministically so
 * pages don't overlap. Use it for any table that can grow past PAGE_SIZE rows.
 */
export async function pageAll<T>(
  build: () => {
    range: (from: number, to: number) => PromiseLike<{ data: unknown[] | null; error?: { message: string } | null }>;
  },
): Promise<T[]> {
  const out: T[] = [];
  for (let from = 0; ; from += PAGE_SIZE) {
    const { data, error } = await build().range(from, from + PAGE_SIZE - 1);
    // A failed page must be LOUD — returning "no rows" here once made every Arrivals
    // receipt read as 0 (an ORDER BY on a column the table doesn't have).
    if (error) throw new Error(`pageAll: ${error.message}`);
    if (!data?.length) break;
    out.push(...(data as T[]));
    if (data.length < PAGE_SIZE) break;
  }
  return out;
}
