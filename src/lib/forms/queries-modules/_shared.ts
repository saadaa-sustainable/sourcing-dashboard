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

/** Pages requested at once. Each page is a round trip to the database; asking for a few at a
 *  time cuts a 14-page read from 14 waits to 4 without flooding the connection pool. */
const PAGE_WAVE = 4;

/**
 * Page through a PostgREST query until it runs dry. `build` must return a fresh
 * query each call (a builder can't be re-ranged), ordered deterministically so
 * pages don't overlap. Use it for any table that can grow past PAGE_SIZE rows.
 * Pages are fetched PAGE_WAVE at a time and joined in order.
 */
export async function pageAll<T>(
  build: () => {
    range: (from: number, to: number) => PromiseLike<{ data: unknown[] | null; error?: { message: string } | null }>;
  },
  /** Stop once this many rows are in hand (the page only shows the newest N). */
  max = Infinity,
): Promise<T[]> {
  const out: T[] = [];
  for (let from = 0; from < max; from += PAGE_SIZE * PAGE_WAVE) {
    const starts: number[] = [];
    for (let k = 0; k < PAGE_WAVE && from + k * PAGE_SIZE < max; k++) starts.push(from + k * PAGE_SIZE);
    const pages = await Promise.all(starts.map((f) => build().range(f, f + PAGE_SIZE - 1)));
    let ended = false;
    for (const { data, error } of pages) {
      // A failed page must be LOUD — returning "no rows" here once made every Arrivals
      // receipt read as 0 (an ORDER BY on a column the table doesn't have).
      if (error) throw new Error(`pageAll: ${error.message}`);
      if (!data?.length) { ended = true; break; }
      out.push(...(data as T[]));
      if (data.length < PAGE_SIZE) { ended = true; break; }
    }
    if (ended) break;
  }
  return out.length > max ? out.slice(0, max) : out;
}
