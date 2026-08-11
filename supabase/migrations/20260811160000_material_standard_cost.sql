-- =====================================================================
-- sd_material_standard_cost — the Standard Cost sheet for MATERIALS, a
-- separate table that mirrors sd_standard_cost exactly and rides the same
-- approval engine (new entity 'material_cost'). Materials have two rate types:
--   job_cost  = Job Work rate (paying for a service, e.g. dyeing)
--   fob_cost  = Purchase rate (buying the material outright)
-- efob_cost is unused for materials (kept only for shape-parity with FG).
--
-- The Buying Plan material track reads the APPROVED rates and computes value:
--   value = job_qty×job_cost + purchase_qty×fob_cost
-- Save → Submit → Approve (admin), same as the FG standard cost sheet.
-- =====================================================================

create table if not exists public.sd_material_standard_cost (
  id              bigserial primary key,
  product_code    text not null unique,          -- holds the material_code
  job_cost        numeric,                        -- Job Work rate
  fob_cost        numeric,                        -- Purchase rate
  efob_cost       numeric,                        -- unused for materials
  status          public.sd_status not null default 'draft',
  submitted_by    text,
  submitted_at    timestamptz,
  approved_by     text,
  approved_at     timestamptz,
  rejection_notes text,
  frozen          boolean not null default false,
  frozen_at       timestamptz,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now()
);
create index if not exists sd_material_standard_cost_status_idx
  on public.sd_material_standard_cost (status);

-- Seed a draft row per active material code so the sheet is a ready worklist.
insert into public.sd_material_standard_cost (product_code)
select material_code from public.sd_material_master
where is_active and coalesce(material_code, '') <> ''
on conflict (product_code) do nothing;

alter table public.sd_material_standard_cost enable row level security;
grant select, insert, update, delete on public.sd_material_standard_cost to authenticated;
grant usage, select on sequence public.sd_material_standard_cost_id_seq to authenticated;
do $$ begin
  if not exists (select 1 from pg_policies where schemaname='public'
                 and tablename='sd_material_standard_cost' and policyname='saadaa read sd_material_standard_cost') then
    execute 'create policy "saadaa read sd_material_standard_cost" on public.sd_material_standard_cost
               for select to authenticated using (public.sd_is_saadaa())';
  end if;
  if not exists (select 1 from pg_policies where schemaname='public'
                 and tablename='sd_material_standard_cost' and policyname='sourcing write sd_material_standard_cost') then
    execute 'create policy "sourcing write sd_material_standard_cost" on public.sd_material_standard_cost
               for all to authenticated using (public.sd_can_write()) with check (public.sd_can_write())';
  end if;
end $$;
