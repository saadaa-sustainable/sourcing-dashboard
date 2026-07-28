-- =====================================================================
-- sd_product_master — the product-level source of truth for attributes the
-- Buying Plan displays but must never let a user type: product status and
-- woven/knitted. Owned by the master (and, later, the FG-Master approval flow +
-- the ">50 pcs/colour → NPD" auto-rule); the Buying Plan only reads it.
--
-- Seeded with every active product code so it is a ready worklist to fill in.
-- fabric_type / product_status start null until populated in the master.
-- =====================================================================

create table if not exists public.sd_product_master (
  product_code   text primary key,
  product_status text,   -- Active | Inactive | TBD | NPD | NPD-Not-Launched | Ongoing | Discontinued
  fabric_type    text,   -- Woven | Knitted
  is_active      boolean not null default true,
  updated_at     timestamptz not null default now()
);

-- Seed the product codes we already know are active (no status/fabric yet).
insert into public.sd_product_master (product_code)
select distinct product_code
from public.sd_active_variants
where product_code is not null and product_code <> ''
on conflict (product_code) do nothing;

alter table public.sd_product_master enable row level security;
grant select, insert, update, delete on public.sd_product_master to authenticated;
do $$ begin
  if not exists (select 1 from pg_policies where schemaname='public'
                 and tablename='sd_product_master' and policyname='saadaa read sd_product_master') then
    execute 'create policy "saadaa read sd_product_master" on public.sd_product_master
               for select to authenticated using (public.sd_is_saadaa())';
  end if;
  if not exists (select 1 from pg_policies where schemaname='public'
                 and tablename='sd_product_master' and policyname='sourcing write sd_product_master') then
    execute 'create policy "sourcing write sd_product_master" on public.sd_product_master
               for all to authenticated using (public.sd_can_write()) with check (public.sd_can_write())';
  end if;
end $$;
