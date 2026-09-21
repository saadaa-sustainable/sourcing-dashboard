<!-- BEGIN:nextjs-agent-rules -->
# This is NOT the Next.js you know

This version has breaking changes — APIs, conventions, and file structure may all differ from your training data. Read the relevant guide in `node_modules/next/dist/docs/` before writing any code. Heed deprecation notices.
<!-- END:nextjs-agent-rules -->

# Keep the pendency log current — every agent, every task

`docs/PENDENCY.md` is the shared task log for this project (local-only: `docs/` is
in `.git/info/exclude`, so it is never committed — but it exists on the machine and
every agent must read and maintain it). It is the single running record of what is
done, deferred, blocked, or awaiting confirmation across all concurrent sessions.

Rules for **all** Claude agents working here:
- **Read `docs/PENDENCY.md` first** when picking up work, to see current state.
- **Update it in the same turn** whenever you complete, defer, discover, or hand off
  work — mark the row (✅ / 🟡 / ⏸️ / ❌ / ❓) and note migrations/commits.
- If you make an assumption or leave something unconfirmed (e.g. a seed list not
  verified with the team), record it explicitly as a ❓ item, don't leave it implicit.
- Never commit `docs/`; it stays local. Only the instruction to maintain it (this
  file) is tracked in git.

# Never read a table without paging it

A single Supabase/PostgREST response stops at **1,000 rows**. Going over is not an error: you
get the first thousand, in no guaranteed order, silently. This has caused three separate
production-data bugs (blank per-size stock, a week's goods receipts understated by two thirds,
a page showing a fifth of the rows its own constant promised).

`.limit(5000)` does **not** raise the cap. A limit above 1,000 is a wish, not a page size.

So: read with `pageAll(() => supabase.from(...)...)` and a stable `.order()`, or `.range()` in
a loop. `.single()`, `.maybeSingle()` and `{ count: 'exact', head: true }` are fine.

`npm run build` runs `scripts/check-unpaged-reads.mjs` first and fails on a new offender. If a
table genuinely cannot reach 1,000 rows, add it to SMALL_TABLES there with the count you
observed. If a read is narrowed so it can only return a few rows, justify it in place:
`// paging-ok: filtered to one PO, at most a few dozen lines`. A waiver with no reason is
rejected.
