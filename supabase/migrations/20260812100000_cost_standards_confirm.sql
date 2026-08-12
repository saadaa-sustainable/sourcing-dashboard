-- =====================================================================
-- Std Cost close-out: document-once standard fields + sequential fabric→CM
-- confirmation.
--
-- 1. sd_cost_standards — a singleton "document once" row: the standard fields
--    that are the same across all products (fabric cost, dyeing cost, shrinkage,
--    margin %, payment terms).
-- 2. Sequential sign-off on FG costs: the fabric rate is confirmed FIRST, then
--    the CM/other rate SECOND (not simultaneous).
-- =====================================================================

create table if not exists public.sd_cost_standards (
  id            integer primary key default 1,
  fabric_cost   numeric,
  dyeing_cost   numeric,
  shrinkage_pct numeric,
  margin_pct    numeric,
  payment_terms text,
  updated_by    text,
  updated_at    timestamptz not null default now(),
  constraint sd_cost_standards_singleton check (id = 1)
);
insert into public.sd_cost_standards (id) values (1) on conflict (id) do nothing;

alter table public.sd_cost_standards enable row level security;
grant select, insert, update on public.sd_cost_standards to authenticated;
do $$ begin
  if not exists (select 1 from pg_policies where schemaname='public'
                 and tablename='sd_cost_standards' and policyname='saadaa read sd_cost_standards') then
    execute 'create policy "saadaa read sd_cost_standards" on public.sd_cost_standards
               for select to authenticated using (public.sd_is_saadaa())';
  end if;
  if not exists (select 1 from pg_policies where schemaname='public'
                 and tablename='sd_cost_standards' and policyname='sourcing write sd_cost_standards') then
    execute 'create policy "sourcing write sd_cost_standards" on public.sd_cost_standards
               for all to authenticated using (public.sd_can_write()) with check (public.sd_can_write())';
  end if;
end $$;

-- Sequential confirmation timestamps (FG cost sheet).
alter table public.sd_standard_cost add column if not exists fabric_confirmed_at timestamptz;
alter table public.sd_standard_cost add column if not exists fabric_confirmed_by text;
alter table public.sd_standard_cost add column if not exists cm_confirmed_at     timestamptz;
alter table public.sd_standard_cost add column if not exists cm_confirmed_by     text;
