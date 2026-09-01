-- =====================================================================
-- EFOB Fabric Cost — the third standard cost component for FOB/EFOB POs (spec §6).
--
-- A fixed rate the company sets MONTHLY for buying fabric / carrying the commodity
-- risk on the vendor's behalf in EFOB arrangements. Kept as its own monthly table,
-- separate from the per-fabric cost sheet (sd_fabric_cost_base) — it's a
-- company-level monthly benchmark, refreshed each month.
-- =====================================================================

create table if not exists public.sd_efob_fabric_cost (
  month      date primary key,   -- first of the month
  rate       numeric,
  updated_by text,
  updated_at timestamptz not null default now()
);

alter table public.sd_efob_fabric_cost enable row level security;
grant select, insert, update, delete on public.sd_efob_fabric_cost to authenticated;
do $$ begin
  if not exists (select 1 from pg_policies where schemaname='public'
                 and tablename='sd_efob_fabric_cost' and policyname='saadaa read sd_efob_fabric_cost') then
    execute 'create policy "saadaa read sd_efob_fabric_cost" on public.sd_efob_fabric_cost
               for select to authenticated using (public.sd_is_saadaa())';
  end if;
  if not exists (select 1 from pg_policies where schemaname='public'
                 and tablename='sd_efob_fabric_cost' and policyname='sourcing write sd_efob_fabric_cost') then
    execute 'create policy "sourcing write sd_efob_fabric_cost" on public.sd_efob_fabric_cost
               for all to authenticated using (public.sd_can_write()) with check (public.sd_can_write())';
  end if;
end $$;
