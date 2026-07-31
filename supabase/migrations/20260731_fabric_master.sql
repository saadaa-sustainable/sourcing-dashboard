-- Fabric master: manually-coded fabric composition records with duplicate prevention.
-- Mirrors the product-master pattern. The code is entered by hand (no auto-generation
-- from composition — same nominal composition can differ by weave/GSM and need distinct
-- codes). The primary key enforces uniqueness; the add action blocks re-use of a code.
create table if not exists public.sd_fabric_master (
  fabric_code        text primary key,
  composition        text,
  warp_count         text,
  weft_count         text,
  third_thread       text,   -- third thread / blend type
  weave              text,
  gsm                numeric,
  raw_material_color text,   -- raw material / colour
  fabric_name        text,   -- optional friendly label shown in the Buying Plan datalist
  is_active          boolean not null default true,
  updated_at         timestamptz not null default now()
);

-- Seed from the existing inventory-derived codes so the Buying Plan datalist loses
-- nothing when it repoints to this master.
insert into public.sd_fabric_master (fabric_code, fabric_name)
select material_code, fabric_name from public.sd_material_codes
on conflict (fabric_code) do nothing;

-- RLS: read for any @saadaa.in; write for team/admin (same as product master).
alter table public.sd_fabric_master enable row level security;
grant select, insert, update, delete on public.sd_fabric_master to authenticated;
do $$ begin
  if not exists (select 1 from pg_policies where schemaname='public'
                 and tablename='sd_fabric_master' and policyname='saadaa read sd_fabric_master') then
    execute 'create policy "saadaa read sd_fabric_master" on public.sd_fabric_master
               for select to authenticated using (public.sd_is_saadaa())';
  end if;
  if not exists (select 1 from pg_policies where schemaname='public'
                 and tablename='sd_fabric_master' and policyname='sourcing write sd_fabric_master') then
    execute 'create policy "sourcing write sd_fabric_master" on public.sd_fabric_master
               for all to authenticated using (public.sd_can_write()) with check (public.sd_can_write())';
  end if;
end $$;

-- Repoint the Buying Plan material datalist at the master (active codes only).
drop view if exists public.sd_material_codes;
create view public.sd_material_codes as
select
  fabric_code as material_code,
  coalesce(fabric_name, composition) as fabric_name
from public.sd_fabric_master
where is_active
order by fabric_code;

grant select on public.sd_material_codes to authenticated;
