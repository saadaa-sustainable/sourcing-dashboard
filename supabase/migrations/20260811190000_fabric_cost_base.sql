-- =====================================================================
-- Fabric cost base sheet — a direct reference table for fabric costing.
--
-- Finished fabric cost is ENTERED directly (grey rate + processing are recorded
-- alongside, informational — not summed). Built in two phases:
--   PR2: baseline grey_rate + processing_cost + finished_fabric_cost.
--   PR3: yarn → grey conversion — yarn_cost + conversion_cost (a one-time setup;
--        grey_rate can be filled as yarn_cost + conversion_cost).
-- Keyed by fabric_code (mirrors sd_fabric_master).
-- =====================================================================

create table if not exists public.sd_fabric_cost_base (
  fabric_code          text primary key,
  yarn_cost            numeric,   -- PR3: yarn cost
  conversion_cost      numeric,   -- PR3: yarn → grey conversion (one-time)
  grey_rate            numeric,   -- PR2: baseline grey rate (≈ yarn + conversion)
  processing_cost      numeric,   -- grey → finished processing
  finished_fabric_cost numeric,   -- entered directly
  notes                text,
  updated_at           timestamptz not null default now()
);

-- Seed a row per active fabric so the sheet is a ready worklist.
insert into public.sd_fabric_cost_base (fabric_code)
select fabric_code from public.sd_fabric_master where is_active
on conflict (fabric_code) do nothing;

alter table public.sd_fabric_cost_base enable row level security;
grant select, insert, update, delete on public.sd_fabric_cost_base to authenticated;
do $$ begin
  if not exists (select 1 from pg_policies where schemaname='public'
                 and tablename='sd_fabric_cost_base' and policyname='saadaa read sd_fabric_cost_base') then
    execute 'create policy "saadaa read sd_fabric_cost_base" on public.sd_fabric_cost_base
               for select to authenticated using (public.sd_is_saadaa())';
  end if;
  if not exists (select 1 from pg_policies where schemaname='public'
                 and tablename='sd_fabric_cost_base' and policyname='sourcing write sd_fabric_cost_base') then
    execute 'create policy "sourcing write sd_fabric_cost_base" on public.sd_fabric_cost_base
               for all to authenticated using (public.sd_can_write()) with check (public.sd_can_write())';
  end if;
end $$;
