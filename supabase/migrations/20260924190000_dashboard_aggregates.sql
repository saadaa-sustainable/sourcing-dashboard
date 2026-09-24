-- Two dashboard reads that were paging raw lines through PostgREST, 1,000 at a time:
--   • the inward trend walked six months of sd_ee_grn — 113,547 rows, 114 sequential
--     pages, each re-sorting the whole filtered set;
--   • missing-TNA-on-closed-POs walked all 16,718 lines of sd_po_completed plus tna_tracker.
-- Together they pushed the main dashboard page past Vercel's 300-second limit and it died
-- after sign-in (2026-09-24, deployment of 2a886f0). Both are one aggregate each in SQL.
--
-- security invoker: they run as the signed-in user, so the tables' own RLS still applies.

create or replace function public.sd_inward_trend(p_months int default 6)
returns table (month text, planned numeric, planned_value numeric, received numeric)
language sql
stable
security invoker
set search_path = ''
as $$
  with m as (
    select (date_trunc('month', (now() at time zone 'Asia/Kolkata')) - (g || ' months')::interval)::date as ms
    from generate_series(0, greatest(coalesce(p_months, 6), 1) - 1) as g
  ),
  b as (select ms, (ms + interval '1 month')::date as me from m)
  select
    to_char(b.ms, 'YYYY-MM')                                                            as month,
    -- planned = the month's inward-plan lines that were not rejected (same rule as the
    -- single-month card in loadAnalyticsExtras, so the two cannot disagree)
    coalesce((select sum(e.inward_qty)
                from public.sd_inward_plan_entry e
               where e.plan_month = b.ms
                 and lower(trim(coalesce(e.approval_status, ''))) <> 'rejected'), 0)     as planned,
    coalesce((select sum(e.inward_qty * coalesce(e.cost_per_piece, 0))
                from public.sd_inward_plan_entry e
               where e.plan_month = b.ms
                 and lower(trim(coalesce(e.approval_status, ''))) <> 'rejected'), 0)     as planned_value,
    -- received = GRN quantity booked in the month
    coalesce((select sum(g.received_quantity)
                from public.sd_ee_grn g
               where g.grn_created_at >= b.ms and g.grn_created_at < b.me), 0)          as received
  from b
  order by b.ms;
$$;

create or replace function public.sd_missing_tna_closed()
returns table (closed int, missing int)
language sql
stable
security invoker
set search_path = ''
as $$
  with done as (
    select distinct upper(trim(po_ref_num)) as po
      from public.sd_po_completed
     where coalesce(trim(po_ref_num), '') <> ''
  ),
  -- A TNA row counts as filled when any core stage has an actual date; a row with none is
  -- as empty as no row at all.
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

grant execute on function public.sd_inward_trend(int) to authenticated;
grant execute on function public.sd_missing_tna_closed() to authenticated;
