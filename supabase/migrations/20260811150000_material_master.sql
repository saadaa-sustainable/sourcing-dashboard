-- =====================================================================
-- Buying Plan — Material track expansion (PR1: structure).
--
-- One Material Master with a type (raw / dyed / trim) as the single code-list
-- authority, a managed colour list for dyed fabrics, plus Job-Work rate / remark
-- / material_type on the plan lines. Rates stay hand-typed for now — the shared
-- Material Standard Cost is PR2.
-- =====================================================================

-- 1. Unified material master. Raw keeps its detailed specs in sd_fabric_master
--    (joined by code); this table is the code-list authority across all types.
create table if not exists public.sd_material_master (
  material_code    text primary key,
  material_type    text not null default 'raw'
                     check (material_type in ('raw', 'dyed', 'trim')),
  name             text,
  colour           text,           -- dyed only: the finished colour
  base_fabric_code text,           -- dyed only: the grey fabric it is dyed from
  default_uom      text,
  is_active        boolean not null default true,
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now()
);
create index if not exists sd_material_master_type_idx
  on public.sd_material_master (material_type) where is_active;

-- Seed raw materials from the existing fabric master so nothing is lost.
insert into public.sd_material_master (material_code, material_type, name, is_active)
select fabric_code, 'raw', coalesce(fabric_name, composition), is_active
from public.sd_fabric_master
on conflict (material_code) do nothing;

-- 2. Managed colour list for dyed fabrics.
create table if not exists public.sd_colour_master (
  colour     text primary key,
  is_active  boolean not null default true,
  created_at timestamptz not null default now()
);
insert into public.sd_colour_master (colour) values
  ('Black'), ('White'), ('Navy'), ('Grey'), ('Rust'), ('Olive'),
  ('Beige'), ('Maroon'), ('Mustard'), ('Teal')
on conflict (colour) do nothing;

-- 3. Plan-line additions: Job-Work rate + remark + which material type the line
--    is. Purchase rate keeps using the existing standard_value column. All
--    nullable; Finished-Goods lines leave them null.
alter table public.sd_buying_plan_line add column if not exists remark        text;
alter table public.sd_buying_plan_line add column if not exists material_type text;
alter table public.sd_buying_plan_line add column if not exists job_rate      numeric;

-- 4. RLS — read for any @saadaa.in, write for team/admin (same as fabric master).
alter table public.sd_material_master enable row level security;
alter table public.sd_colour_master   enable row level security;
grant select, insert, update, delete on public.sd_material_master, public.sd_colour_master to authenticated;
do $$ begin
  if not exists (select 1 from pg_policies where schemaname='public'
                 and tablename='sd_material_master' and policyname='saadaa read sd_material_master') then
    execute 'create policy "saadaa read sd_material_master" on public.sd_material_master
               for select to authenticated using (public.sd_is_saadaa())';
  end if;
  if not exists (select 1 from pg_policies where schemaname='public'
                 and tablename='sd_material_master' and policyname='sourcing write sd_material_master') then
    execute 'create policy "sourcing write sd_material_master" on public.sd_material_master
               for all to authenticated using (public.sd_can_write()) with check (public.sd_can_write())';
  end if;
  if not exists (select 1 from pg_policies where schemaname='public'
                 and tablename='sd_colour_master' and policyname='saadaa read sd_colour_master') then
    execute 'create policy "saadaa read sd_colour_master" on public.sd_colour_master
               for select to authenticated using (public.sd_is_saadaa())';
  end if;
  if not exists (select 1 from pg_policies where schemaname='public'
                 and tablename='sd_colour_master' and policyname='sourcing write sd_colour_master') then
    execute 'create policy "sourcing write sd_colour_master" on public.sd_colour_master
               for all to authenticated using (public.sd_can_write()) with check (public.sd_can_write())';
  end if;
end $$;

-- 5. Repoint the Buying Plan material datalist at the master, now carrying the
--    type + colour so the plan can filter by Raw / Dyed / Trims.
drop view if exists public.sd_material_codes;
create view public.sd_material_codes
  with (security_invoker = on) as
select
  material_code,
  material_type,
  coalesce(name, material_code) as fabric_name,
  colour,
  base_fabric_code
from public.sd_material_master
where is_active
order by material_type, material_code;

grant select on public.sd_material_codes to authenticated;
