# Backend setup — what you do

The frontend is written and will build. It cannot do anything until these are
done. Steps 1 and 2 unblock Friday's forms. Step 3 unblocks the PO pipeline and
everything downstream.

---

## 1. Supabase — run the migration (15 min, unblocks all three forms)

**Where:** Supabase dashboard → your sourcing project → SQL Editor.

1. Open `supabase/migrations/20260723120000_sourcing_workflows.sql`.
2. **Edit the last block first** — the seed users at the bottom. Replace the four
   emails with real ones and set the roles:
   - `admin` — you
   - `approver_l2` — Mahesh
   - `approver_l1` — Mukesh ji
   - `supply_chain` — everyone who fills the forms (Durganshu ji, Anubhuti)
   Anyone signing in who is not in `sd_user` gets `viewer` — read-only, no error.
3. Paste the whole file into the SQL Editor. Run.
4. Verify:
   ```sql
   select * from public.sd_user;
   select count(*) from public.sd_active_variants;   -- expect a few hundred
   select public.sd_current_role();                  -- returns your role
   ```

**If step 4's last query returns `viewer` when you're admin:** your JWT email
casing doesn't match. `sd_user.email` must be lowercase.

**If a policy fails to create:** the base migration ran `revoke all`, so grants
must land before policies. The `do $$` block handles this — but if you run the
file in pieces, run it top to bottom.

### One thing to check by hand

`sd_active_variants` reads `pending_po_master.product_variant`. If your variant
column is mostly blank, the Buying Plan and Discontinue dropdowns will be empty:

```sql
select count(*) filter (where coalesce(btrim(product_variant),'') <> '') as with_variant,
       count(*) as total
from public.pending_po_master where is_active;
```

If `with_variant` is near zero, the colour data isn't flowing from the sheet —
fix that before Friday or the forms will look broken.

---

## 2. Deploy the frontend (10 min)

1. Copy the files in `src/` over your repo, preserving paths.
2. Apply the two edits in `PATCHES.md` (`layout.tsx` import, sidebar links).
3. `npm run typecheck && npm run build` locally before pushing.
4. Push to master — Vercel auto-deploys.

**No new npm packages needed.** Everything uses `lucide-react`, `@supabase/ssr`
and React 19, already in `package.json`.

**No new env vars needed for steps 1–2.** The forms write through the signed-in
user's JWT, so RLS does the enforcement — the same
`NEXT_PUBLIC_SUPABASE_URL` / `NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY` you already
have is enough.

---

## 3. GCP / BigQuery — PO pipeline

This is the one that can slip. Start the access request today; the code is a
day's work once the key exists.

### 3a. Find out who owns the project

The dataset is in **`saadaa-wh`**, which is Harsh's / MapleMonk's project, not
yours. You likely cannot create a service account in it yourself.

**Ask Sohan ji first** — per the transcript he already had someone set up
BigQuery access during the ERP work, and he may hold a key. That's faster than a
fresh IAM request.

### 3b. Service account (whoever has Owner on `saadaa-wh` does this)

GCP Console → IAM & Admin → Service Accounts → **Create service account**

- Name: `sourcing-po-sync`
- Grant **both** roles — this is the step people get wrong:

  | Role | Scope | Why |
  |---|---|---|
  | **BigQuery Data Viewer** | dataset `MAPLEMONK` | read the rows |
  | **BigQuery Job User** | project `saadaa-wh` | *run* the query |

  Data Viewer alone cannot execute even a `SELECT`. You'll get
  `Access Denied: Project saadaa-wh: User does not have bigquery.jobs.create`.

- Keys → Add key → **JSON** → download. Treat it like a password.

### 3c. Things to ask for at the same time

Ask once, not four times:

1. **Dataset region** — `US`, `asia-south1`, something else? The BigQuery client
   needs `location` to match exactly or the query returns empty with no error.
2. **The purchase order master table name** — full path
   `saadaa-wh.MAPLEMONK.<table>`.
3. **PO status codes** — which integers mean in-process vs completed. Mahesh was
   explicit that you split this yourself rather than inheriting MapleMonk's
   filter. Without the code list you cannot build the split.
4. **Whether the raw table is refreshed on a schedule**, and at what time — your
   cron must run after it.

### 3d. Vercel env vars (once you have the key)

Vercel → project → Settings → Environment Variables:

```
GCP_SA_KEY             = <the entire JSON key, on one line>
BQ_LOCATION            = US            ← whatever 3c.1 says
BQ_PO_TABLE            = saadaa-wh.MAPLEMONK.<table>
SUPABASE_SERVICE_ROLE  = <service_role key from Supabase → API settings>
CRON_SECRET            = <a long random string>
```

⚠️ `SUPABASE_SERVICE_ROLE` is **not** the anon/publishable key. The README says
to keep it out of Next.js — that still holds for page rendering. It is required
for the cron route only, which is server-only and never bundled to the browser.
Never prefix it `NEXT_PUBLIC_`.

### 3e. Cron schedule

`vercel.json` at repo root:

```json
{
  "crons": [
    { "path": "/api/cron/po-sync", "schedule": "30 18 * * *" },
    { "path": "/api/cron/po-sync", "schedule": "30 6 * * *" }
  ]
}
```

**Cron is UTC.** `30 18` = 00:00 IST, `30 6` = 12:00 IST. Mahesh asked for twice
daily — midnight and evening. Adjust the second one once you know the refresh
time from 3c.4.

On the Vercel Hobby plan crons fire within a ~1 hour window and are daily-only;
check your tier before promising midnight precision.

### 3f. Tell me when 3b–3d are done

Send me the answers to 3c and I'll write `/api/cron/po-sync` — the ingest,
the `sd_po_master_raw` table, and the in-process / completed split views. It's
about 120 lines and I can't write the status filter without the code list.

---

## 4. EasyCom — long term, not now

Mahesh wants the eventual source to be EasyCom direct rather than BigQuery.
Talk to **Shahrukh** about API access. Don't block Friday on it — BigQuery first,
EasyCom is a swap of the ingest source later.

The `"200 buds free"` line in the transcript is garbled. Ask what the actual
quota is before designing around it.

---

## Order of operations

| | Task | Time | Blocks |
|---|---|---|---|
| 1 | Run the migration | 15 min | all three forms |
| 2 | Deploy frontend | 10 min | all three forms |
| 3 | Verify `product_variant` populated | 5 min | Discontinue dropdown |
| 4 | Ask Sohan ji for the BigQuery key | today | PO pipeline, PO approval, inward plan |
| 5 | Ask Mahesh the 5 open questions below | today | Buying Plan correctness |

Steps 1–3 are ~30 minutes and get Friday's deliverables live.

---

## Still blocked on Mahesh

Wired into the UI as best-guess defaults; confirm before anyone relies on them.

1. **"Whichever is lower"** — he said need 550, job work recommends 237, FOB
   allows 950, *"hamesha lenge whichever is lower."* But he also said allocation
   can exceed pending. Right now the form takes free input and blocks nothing.
   Is the lower figure a hard cap, or advisory?
2. **`pending_quantity` source** — the replenishment module doesn't exist. The
   column is nullable and shows `—`. Manual entry, or derive from open-PO pending?
3. **E-FOB stock days** — seeded as 41 from the transcript; 30 × 1.5 = 45.
4. **Discontinue** — who submits vs who approves? Currently anyone
   `supply_chain`+ submits, `approver_l2` decides.
5. **Buying value** — the form takes `standard_value` as input. Should it derive
   from last-bought price by PO type instead, or ingest the standard costing sheet?

Questions 1 and 2 change the Buying Plan's behaviour, not just its labels.
