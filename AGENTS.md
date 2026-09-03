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
