-- Vendor Capacity: keep each vendor's in-process quantity per week, so a past week on the
-- Vendor Capacity board shows what was on order then (not today's open POs).
--
-- sd_vendor_in_process is a live view (approved POs not yet received). Every hour the current
-- IST week's row is overwritten with the live figure, so once a week is over its row holds
-- the position at the end of that week (the last hourly copy before Sunday midnight).
-- Weeks run Monday to Sunday, IST — the same week the board and capacityWeekStart() use.
-- Starts from the week this is applied; earlier weeks have no copy and keep showing today's.

create table if not exists public.sd_vendor_in_process_weekly (
  week          date        not null,  -- the week's Monday (IST)
  vendor_code   text        not null,
  in_process_qty numeric    not null default 0,
  captured_at   timestamptz not null default now(),
  primary key (week, vendor_code)
);

alter table public.sd_vendor_in_process_weekly enable row level security;

drop policy if exists sd_vendor_in_process_weekly_read on public.sd_vendor_in_process_weekly;
create policy sd_vendor_in_process_weekly_read on public.sd_vendor_in_process_weekly
  for select to authenticated using ((select public.sd_is_saadaa()));

revoke all on public.sd_vendor_in_process_weekly from anon;
revoke insert, update, delete, truncate on public.sd_vendor_in_process_weekly from authenticated;
grant select on public.sd_vendor_in_process_weekly to authenticated;

create or replace function public.sd_snapshot_vendor_in_process()
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  wk date := date_trunc('week', now() at time zone 'Asia/Kolkata')::date;  -- Monday
begin
  -- A vendor whose POs all arrived during the week ends it at 0, not at its last open figure.
  delete from public.sd_vendor_in_process_weekly w
   where w.week = wk
     and not exists (
       select 1 from public.sd_vendor_in_process v
        where lower(trim(v.vendor_code)) = w.vendor_code
     );

  insert into public.sd_vendor_in_process_weekly (week, vendor_code, in_process_qty, captured_at)
  select wk, lower(trim(v.vendor_code)), sum(coalesce(v.in_process_qty, 0)), now()
    from public.sd_vendor_in_process v
   where coalesce(trim(v.vendor_code), '') <> ''
   group by lower(trim(v.vendor_code))
  on conflict (week, vendor_code) do update
    set in_process_qty = excluded.in_process_qty,
        captured_at    = excluded.captured_at;
end;
$$;
revoke all on function public.sd_snapshot_vendor_in_process() from public, anon, authenticated;

-- Hourly (UTC minute 25); 23 vendors, a few milliseconds.
select cron.unschedule(jobid) from cron.job where jobname = 'vendor-in-process-weekly';
select cron.schedule('vendor-in-process-weekly', '25 * * * *', 'select public.sd_snapshot_vendor_in_process()');

-- First copy now, for the current week.
select public.sd_snapshot_vendor_in_process();
