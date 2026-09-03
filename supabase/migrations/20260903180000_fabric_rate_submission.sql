-- Item 5 (mandatory monthly EFOB rate submission). Each fabric's grey + finished
-- rate must be reviewed EVERY month by whoever owns costing — either an updated rate
-- OR an explicit "no change". "No change" is a valid submission; silence (no row for
-- the month) is NOT — that's what the pending-this-month reminder surfaces.
-- Per-fabric per-month (team's choice), one row per (fabric_code, month).
--
-- A real change also writes through to sd_fabric_cost_base (the live rate feeding the
-- recompute); a no-change submission just records that the month was reviewed.
create table if not exists public.sd_fabric_rate_submission (
  id            bigint generated always as identity primary key,
  fabric_code   text not null,
  month         date not null,          -- first of the month this submission covers
  grey_rate     numeric,
  finished_rate numeric,
  no_change     boolean not null default false,
  submitted_by  text,
  submitted_at  timestamptz not null default now(),
  unique (fabric_code, month)
);

create index if not exists sd_fabric_rate_submission_month_idx
  on public.sd_fabric_rate_submission (month desc, fabric_code);

alter table public.sd_fabric_rate_submission enable row level security;

drop policy if exists sd_fabric_rate_submission_read on public.sd_fabric_rate_submission;
create policy sd_fabric_rate_submission_read on public.sd_fabric_rate_submission
  for select using (public.sd_is_saadaa());

drop policy if exists sd_fabric_rate_submission_write on public.sd_fabric_rate_submission;
create policy sd_fabric_rate_submission_write on public.sd_fabric_rate_submission
  for insert with check (public.sd_can_write());

drop policy if exists sd_fabric_rate_submission_update on public.sd_fabric_rate_submission;
create policy sd_fabric_rate_submission_update on public.sd_fabric_rate_submission
  for update using (public.sd_can_write()) with check (public.sd_can_write());
