-- Out-of-stock one-pager: daily history so the OOS% trend can be charted.
--
-- The inventory-planning feed holds ONE day (the latest nightly snapshot), so "yesterday"
-- is always readable but a trend is not. Same device as sd_tna_status_snapshot: the first
-- load of the OOS page for a data day writes one row per scope ('all' plus one per
-- category) and later loads are no-ops. The date is the DATA day (sd_inventory_planning
-- .date_day), not the day someone opened the page, so the x-axis says "position as of".

create table public.sd_oos_daily_snapshot (
  snapshot_date  date    not null,
  scope          text    not null,               -- 'all' or a category name
  skus           integer not null default 0,
  oos_yesterday  integer not null default 0,     -- SKUs with no stock on snapshot_date
  oos_45         integer not null default 0,     -- SKUs with >= 1 empty day in the 45 days to it
  oos_365        integer not null default 0,     -- ... in the 365 days to it
  oos_days_45    bigint  not null default 0,     -- sum of empty SKU-days, 45-day window
  oos_days_365   bigint  not null default 0,     -- ... 365-day window
  recovered_45   integer not null default 0,     -- empty at some point in 45 days, stocked on snapshot_date
  created_at     timestamptz not null default now(),
  primary key (snapshot_date, scope)
);

alter table public.sd_oos_daily_snapshot enable row level security;
create policy "saadaa read sd_oos_daily_snapshot" on public.sd_oos_daily_snapshot
  for select to authenticated using (public.sd_is_saadaa());
grant select on public.sd_oos_daily_snapshot to authenticated;

-- Idempotent recorder, SECURITY DEFINER so a viewer's page load can record without a
-- write policy. One call carries every scope for the day.
create or replace function public.sd_record_oos_snapshot(p_day date, p_rows jsonb)
returns void
language sql security definer set search_path = ''
as $$
  insert into public.sd_oos_daily_snapshot
    (snapshot_date, scope, skus, oos_yesterday, oos_45, oos_365, oos_days_45, oos_days_365, recovered_45)
  select p_day, r.scope, r.skus, r.oos_yesterday, r.oos_45, r.oos_365, r.oos_days_45, r.oos_days_365, r.recovered_45
  from jsonb_to_recordset(p_rows) as r(
    scope text, skus integer, oos_yesterday integer, oos_45 integer, oos_365 integer,
    oos_days_45 bigint, oos_days_365 bigint, recovered_45 integer)
  on conflict (snapshot_date, scope) do nothing;
$$;

revoke all on function public.sd_record_oos_snapshot(date, jsonb) from public;
grant execute on function public.sd_record_oos_snapshot(date, jsonb) to authenticated;
