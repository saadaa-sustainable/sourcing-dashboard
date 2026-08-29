-- =====================================================================
-- CMTP cost breakdown — the CM (Cutting/Manufacturing/Trims/Packaging) cost is
-- built up from category heads, not entered as a single number.
--
-- 6 core mandatory heads (the "core architecture"): Labor, Cutting, Finishing,
-- Packaging, Brand Trims, Product Trims. Finishing rolls up sub-items (thread
-- cutting, final QC, fabric QC, folding, ironing). The team can add more line
-- items / heads ad hoc. The CMTP total (sum of all line items) IS the product's
-- CM cost (sd_standard_cost.cm_cost) — a documentation column; the Buying Plan
-- values from job/fob/efob, never cm_cost, so this is safe.
--
-- One row per line item under a product. A head with a single plain amount has
-- one row (empty label); a head with sub-items has one row per sub-item.
-- =====================================================================

create table if not exists public.sd_cmtp_component (
  id           bigserial primary key,
  product_code text not null,
  category     text not null,          -- one of the 6 heads, or a custom head
  label        text,                   -- sub-item name; null/empty = plain head amount
  amount       numeric,
  position     integer not null default 0,
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now()
);
create index if not exists sd_cmtp_component_code_idx
  on public.sd_cmtp_component (product_code);

alter table public.sd_cmtp_component enable row level security;
grant select, insert, update, delete on public.sd_cmtp_component to authenticated;
grant usage, select on sequence public.sd_cmtp_component_id_seq to authenticated;
do $$ begin
  if not exists (select 1 from pg_policies where schemaname='public'
                 and tablename='sd_cmtp_component' and policyname='saadaa read sd_cmtp_component') then
    execute 'create policy "saadaa read sd_cmtp_component" on public.sd_cmtp_component
               for select to authenticated using (public.sd_is_saadaa())';
  end if;
  if not exists (select 1 from pg_policies where schemaname='public'
                 and tablename='sd_cmtp_component' and policyname='sourcing write sd_cmtp_component') then
    execute 'create policy "sourcing write sd_cmtp_component" on public.sd_cmtp_component
               for all to authenticated using (public.sd_can_write()) with check (public.sd_can_write())';
  end if;
end $$;
