-- Item 2 (line-item Standard Cost revisions with mandatory reason). Once a CMTP
-- breakdown exists, changing a single line (Mahesh's example: only the karigar/CM
-- rate moved, or one trim's dyeing rate) must record WHY — a mandatory reason — as
-- an append-only audit row: old value, new value, who, when, reason. Shown in the
-- Standard Cost Rate History view next to the accepted-rate log.
--
-- Kept as its OWN table (not folded into sd_standard_cost_rate_history) on purpose:
-- the Buying Plan reads the LATEST rate-history row as the live standard rate, so a
-- CMTP-revision row (which has no job/fob/efob rate) must never land there.
create table if not exists public.sd_cmtp_revision (
  id           bigint generated always as identity primary key,
  product_code text not null,
  category     text not null,          -- CMTP head (Labour, Cutting, …)
  label        text,                   -- sub-item within the head (null = plain head amount)
  old_amount   numeric,                -- amount before the change (null = line added)
  new_amount   numeric,                -- amount after the change (null = line removed)
  cm_before    numeric,                -- product CM total before this save
  cm_after     numeric,                -- product CM total after this save
  reason       text not null,          -- MANDATORY motivation for the change
  revised_by   text,
  revised_at   timestamptz not null default now()
);

create index if not exists sd_cmtp_revision_product_idx
  on public.sd_cmtp_revision (product_code, revised_at desc);

alter table public.sd_cmtp_revision enable row level security;

-- Same visibility model as the rest of the sd_ tables: SAADAA staff read; writes go
-- through the signed-in user's JWT from the server action (sd_can_write()).
drop policy if exists sd_cmtp_revision_read on public.sd_cmtp_revision;
create policy sd_cmtp_revision_read on public.sd_cmtp_revision
  for select using (public.sd_is_saadaa());

drop policy if exists sd_cmtp_revision_write on public.sd_cmtp_revision;
create policy sd_cmtp_revision_write on public.sd_cmtp_revision
  for insert with check (public.sd_can_write());
