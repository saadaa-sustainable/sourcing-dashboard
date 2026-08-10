-- =====================================================================
-- Stage-form INSPECTION details for the Open PO Tracker's inline TNA breakdown.
--
-- The six production stage-form mirror tables (see 20260805130000_stage_form_actuals)
-- store one row per Google-Form submission. This migration adds the inspection
-- columns those forms carry -- pass/fail result, the attached report link, and a
-- remark -- so the tracker can show, per stage: the PASS date, a count of inspection
-- attempts (fails before a pass), the report PDF, and the fail context.
--
-- sd_po_stage_actuals becomes PASS-preferring (each stage's actual is the pass date
-- when a pass exists, else the latest actual). sd_po_stage_inspections exposes one
-- row per submission (pass or fail) for the expandable breakdown panel.
-- =====================================================================

-- 1. Add inspection columns to all six mirror tables (mark-and-sweep untouched).
do $$
declare t text;
begin
  foreach t in array array['pp_sample_form','gpt_form','cutting_form','inline_qc_form','pdi_form','po_closure_form']
  loop
    execute format('alter table public.%1$I add column if not exists result text', t);
    execute format('alter table public.%1$I add column if not exists report_url text', t);
    execute format('alter table public.%1$I add column if not exists remarks text', t);
  end loop;
end $$;

-- 2. sd_po_stage_actuals -- one row per PO ref, each stage's PASS-preferring actual.
create or replace view public.sd_po_stage_actuals
  with (security_invoker = on) as
with u as (
  select upper(btrim(po_ref_num)) as po_ref_num, 'pp' as stage, actual_date, result from public.pp_sample_form   where is_active and actual_date is not null
  union all
  select upper(btrim(po_ref_num)), 'gpt',     actual_date, result from public.gpt_form         where is_active and actual_date is not null
  union all
  select upper(btrim(po_ref_num)), 'cutting', actual_date, result from public.cutting_form     where is_active and actual_date is not null
  union all
  select upper(btrim(po_ref_num)), 'inline',  actual_date, result from public.inline_qc_form   where is_active and actual_date is not null
  union all
  select upper(btrim(po_ref_num)), 'pdi',     actual_date, result from public.pdi_form         where is_active and actual_date is not null
  union all
  select upper(btrim(po_ref_num)), 'closer',  actual_date, result from public.po_closure_form  where is_active and actual_date is not null
),
-- Per (PO, stage): the pass date if any pass exists, else the latest actual.
p as (
  select po_ref_num, stage,
    coalesce(
      max(actual_date) filter (where lower(btrim(coalesce(result, ''))) = 'pass'),
      max(actual_date)
    ) as actual
  from u
  where po_ref_num <> ''
  group by po_ref_num, stage
)
select po_ref_num,
  max(actual) filter (where stage = 'pp')      as pp_actual,
  max(actual) filter (where stage = 'gpt')     as gpt_actual,
  max(actual) filter (where stage = 'cutting') as cutting_actual,
  max(actual) filter (where stage = 'inline')  as inline_actual,
  max(actual) filter (where stage = 'pdi')     as first_delivery_actual,
  max(actual) filter (where stage = 'closer')  as po_closer_actual
from p
group by po_ref_num;

grant select on public.sd_po_stage_actuals to authenticated;

-- 3. sd_po_stage_inspections -- one row per submission (pass AND fail) for the panel.
-- Rows with no stage date are kept (fails often carry only a submission timestamp).
create or replace view public.sd_po_stage_inspections
  with (security_invoker = on) as
select upper(btrim(po_ref_num)) as po_ref_num, 'pp' as stage, actual_date, submitted_at, result, report_url, remarks from public.pp_sample_form   where is_active
union all
select upper(btrim(po_ref_num)), 'gpt',     actual_date, submitted_at, result, report_url, remarks from public.gpt_form         where is_active
union all
select upper(btrim(po_ref_num)), 'cutting', actual_date, submitted_at, result, report_url, remarks from public.cutting_form     where is_active
union all
select upper(btrim(po_ref_num)), 'inline',  actual_date, submitted_at, result, report_url, remarks from public.inline_qc_form   where is_active
union all
select upper(btrim(po_ref_num)), 'pdi',     actual_date, submitted_at, result, report_url, remarks from public.pdi_form         where is_active
union all
select upper(btrim(po_ref_num)), 'closer',  actual_date, submitted_at, result, report_url, remarks from public.po_closure_form  where is_active;

grant select on public.sd_po_stage_inspections to authenticated;
