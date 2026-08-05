-- =====================================================================
-- Stage-form ACTUAL dates for the Open PO Tracker.
--
-- The team logs each production stage's completion through Google Forms in the
-- "Production Dashboard" spreadsheet (a DIFFERENT spreadsheet from sourcing/TNA).
-- Six response tabs are mirrored here (one MIRROR table per tab — mark-and-sweep
-- is per-table). No sd_ prefix: sheet is the source of truth, read-only in-app.
--
-- sd_po_stage_actuals pivots them to one row per PO ref with each stage's actual
-- date; src/lib/data.ts overrides the tracker's *_actual_date fields from it,
-- leaving the planned (TNA/expected) dates from tna_tracker untouched.
-- =====================================================================

-- Six identical mirror tables.
do $$
declare t text;
begin
  foreach t in array array['pp_sample_form','gpt_form','cutting_form','inline_qc_form','pdi_form','po_closure_form']
  loop
    execute format($f$
      create table if not exists public.%1$I (
        source_row_key text primary key,
        po_ref_num     text,
        actual_date    date,
        submitted_at   timestamptz,
        is_active      boolean not null default true,
        sync_token     text,
        synced_at      timestamptz not null default now()
      );
      create index if not exists %1$s_po_idx on public.%1$I (po_ref_num);
      create index if not exists %1$s_active_idx on public.%1$I (is_active) where is_active;
      alter table public.%1$I enable row level security;
      revoke all on table public.%1$I from anon, authenticated;
      grant select on table public.%1$I to authenticated;
    $f$, t);
    if not exists (select 1 from pg_policies where schemaname='public' and tablename=t
                   and policyname='saadaa read '||t) then
      execute format('create policy %1$I on public.%2$I for select to authenticated using (public.sd_is_saadaa())',
        'saadaa read '||t, t);
    end if;
  end loop;
end $$;

-- One row per PO ref with each stage's latest actual date. security_invoker so it
-- honours the caller's RLS on the underlying mirror tables.
create or replace view public.sd_po_stage_actuals
  with (security_invoker = on) as
with u as (
  select upper(btrim(po_ref_num)) as po_ref_num, 'pp' as stage, actual_date from public.pp_sample_form   where is_active and actual_date is not null
  union all
  select upper(btrim(po_ref_num)), 'gpt',     actual_date from public.gpt_form         where is_active and actual_date is not null
  union all
  select upper(btrim(po_ref_num)), 'cutting', actual_date from public.cutting_form     where is_active and actual_date is not null
  union all
  select upper(btrim(po_ref_num)), 'inline',  actual_date from public.inline_qc_form   where is_active and actual_date is not null
  union all
  select upper(btrim(po_ref_num)), 'pdi',     actual_date from public.pdi_form         where is_active and actual_date is not null
  union all
  select upper(btrim(po_ref_num)), 'closer',  actual_date from public.po_closure_form  where is_active and actual_date is not null
)
select po_ref_num,
  max(actual_date) filter (where stage = 'pp')      as pp_actual,
  max(actual_date) filter (where stage = 'gpt')     as gpt_actual,
  max(actual_date) filter (where stage = 'cutting') as cutting_actual,
  max(actual_date) filter (where stage = 'inline')  as inline_actual,
  max(actual_date) filter (where stage = 'pdi')     as first_delivery_actual,
  max(actual_date) filter (where stage = 'closer')  as po_closer_actual
from u
where po_ref_num <> ''
group by po_ref_num;

grant select on public.sd_po_stage_actuals to authenticated;
