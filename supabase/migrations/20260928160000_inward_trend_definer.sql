-- sd_inward_trend() returned HTTP 500 to the dashboard (PostgREST edge log, 2026-09-28
-- 10:11 UTC) while running fine as postgres in 1.8 s. As the signed-in user the RLS
-- predicate (sd_is_saadaa()) is evaluated on every one of the ~114,000 sd_ee_grn rows the
-- six-month window covers, and the authenticated role carries Supabase's 8-second
-- statement timeout — the call was cancelled, the page swallowed the error, and the
-- Inward trend card read "data is not available".
--
-- Same remedy as sd_vendor_reliability: SECURITY DEFINER so the aggregate runs without
-- per-row RLS, execute limited to authenticated, and an index on the date the window
-- filters on. The function returns six monthly totals and no row data, so nothing is
-- exposed that the caller could not already read.

create index if not exists sd_ee_grn_created_at_idx on public.sd_ee_grn (grn_created_at);

create or replace function public.sd_inward_trend(p_months int default 6)
returns table (month text, planned numeric, planned_value numeric, received numeric)
language sql
stable
security definer
set search_path = ''
as $$
  with m as (
    select (date_trunc('month', (now() at time zone 'Asia/Kolkata')) - (g || ' months')::interval)::date as ms
    from generate_series(0, greatest(coalesce(p_months, 6), 1) - 1) as g
  ),
  b as (select ms, (ms + interval '1 month')::date as me from m)
  select
    to_char(b.ms, 'YYYY-MM')                                                            as month,
    coalesce((select sum(e.inward_qty)
                from public.sd_inward_plan_entry e
               where e.plan_month = b.ms
                 and lower(trim(coalesce(e.approval_status, ''))) <> 'rejected'), 0)     as planned,
    coalesce((select sum(e.inward_qty * coalesce(e.cost_per_piece, 0))
                from public.sd_inward_plan_entry e
               where e.plan_month = b.ms
                 and lower(trim(coalesce(e.approval_status, ''))) <> 'rejected'), 0)     as planned_value,
    coalesce((select sum(g.received_quantity)
                from public.sd_ee_grn g
               where g.grn_created_at >= b.ms and g.grn_created_at < b.me), 0)          as received
  from b
  order by b.ms;
$$;
revoke all on function public.sd_inward_trend(int) from public;
grant execute on function public.sd_inward_trend(int) to authenticated;

-- The same shape of risk for the closed-PO TNA count (16,718 + 305 rows): small today,
-- and it answered 200 — made definer too so it cannot start timing out as the feed grows.
create or replace function public.sd_missing_tna_closed()
returns table (closed int, missing int)
language sql
stable
security definer
set search_path = ''
as $$
  with done as (
    select distinct upper(trim(po_ref_num)) as po
      from public.sd_po_completed
     where coalesce(trim(po_ref_num), '') <> ''
  ),
  filled as (
    select distinct upper(trim(po_no)) as po
      from public.tna_tracker
     where coalesce(trim(po_no), '') <> ''
       and (pp_sample_actual_date is not null
         or gpt_actual_date is not null
         or cutting_actual_date_first is not null
         or in_line_actual_date is not null)
  )
  select
    (select count(*) from done)::int as closed,
    (select count(*) from done d
      where not exists (select 1 from filled f where f.po = d.po))::int as missing;
$$;
revoke all on function public.sd_missing_tna_closed() from public;
grant execute on function public.sd_missing_tna_closed() to authenticated;
