-- =====================================================================
-- Inward Plan II — team-filled monthly inward sheet (Buying Plan tab).
--
-- Mirrors the team's Google-Sheet "INWARD PLAN <Month>": one row per
-- product × PO the team intends to inward this month. Product code comes
-- from the buying plan; PO / vendor / qty / cost / remarks are manual team
-- input; MT COMMENTS + Approval Status are the management review; actual
-- inward qty lands later. Total Value (qty × cost) and Variation
-- (actual − planned) are computed in the UI, never stored.
-- =====================================================================

create table if not exists public.sd_inward_plan_entry (
  id                bigint generated always as identity primary key,
  plan_month        date not null,             -- first of the month
  product_code      text not null,
  po_no             text,
  vendor_name       text,
  inward_qty        numeric,
  cost_per_piece    numeric,
  remarks           text,
  mt_comments       text,                      -- management review note
  approval_status   text not null default 'Pending',  -- Pending / Approved / RE-WORK / Rejected
  actual_inward_qty numeric,                   -- filled as the month closes
  created_by        text,
  updated_by        text,
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now()
);

create index if not exists sd_inward_plan_entry_month_idx
  on public.sd_inward_plan_entry (plan_month);

alter table public.sd_inward_plan_entry enable row level security;
grant select, insert, update, delete on public.sd_inward_plan_entry to authenticated;
do $$ begin
  if not exists (select 1 from pg_policies where schemaname='public'
                 and tablename='sd_inward_plan_entry' and policyname='saadaa read sd_inward_plan_entry') then
    execute 'create policy "saadaa read sd_inward_plan_entry" on public.sd_inward_plan_entry
               for select to authenticated using (public.sd_is_saadaa())';
  end if;
  if not exists (select 1 from pg_policies where schemaname='public'
                 and tablename='sd_inward_plan_entry' and policyname='sourcing write sd_inward_plan_entry') then
    execute 'create policy "sourcing write sd_inward_plan_entry" on public.sd_inward_plan_entry
               for all to authenticated using (public.sd_can_write()) with check (public.sd_can_write())';
  end if;
end $$;
