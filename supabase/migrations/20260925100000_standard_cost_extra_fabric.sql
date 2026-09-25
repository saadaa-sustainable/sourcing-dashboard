-- =====================================================================
-- Standard Cost — additional fabrics on one product.
--
-- Some garments are cut from two (or more) fabrics. The cost sheet so far held ONE
-- fabric per product (sd_standard_cost.fabric_code) with the per-size consumption on
-- sd_standard_cost_line. That first fabric stays exactly where it is. Every further
-- fabric the team adds lives here: one row per (product, fabric, size) carrying that
-- fabric's consumption and its cost at the Fabric Cost master's finished rate.
--
-- sd_standard_cost_line.fabric_cost / total_cost keep meaning the size's WHOLE fabric
-- cost (all fabrics) and the whole garment, so the Buying Plan, the PO-average final
-- price and the PO cost checks keep reading the same columns they always did.
-- =====================================================================

create table if not exists public.sd_standard_cost_extra_fabric (
  id           bigserial primary key,
  product_code text not null,
  fabric_code  text not null,
  -- 1 = the second fabric, 2 = the third … (the first fabric is on sd_standard_cost)
  position     int  not null default 1,
  size         text not null,
  consumption  numeric,
  fabric_cost  numeric,
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now(),
  unique (product_code, fabric_code, size)
);
create index if not exists sd_standard_cost_extra_fabric_code_idx
  on public.sd_standard_cost_extra_fabric (product_code);

alter table public.sd_standard_cost_extra_fabric enable row level security;
grant select, insert, update, delete on public.sd_standard_cost_extra_fabric to authenticated;
grant usage, select on sequence public.sd_standard_cost_extra_fabric_id_seq to authenticated;
do $$ begin
  if not exists (select 1 from pg_policies where schemaname='public'
                 and tablename='sd_standard_cost_extra_fabric'
                 and policyname='saadaa read sd_standard_cost_extra_fabric') then
    execute 'create policy "saadaa read sd_standard_cost_extra_fabric" on public.sd_standard_cost_extra_fabric
               for select to authenticated using (public.sd_is_saadaa())';
  end if;
  if not exists (select 1 from pg_policies where schemaname='public'
                 and tablename='sd_standard_cost_extra_fabric'
                 and policyname='sourcing write sd_standard_cost_extra_fabric') then
    execute 'create policy "sourcing write sd_standard_cost_extra_fabric" on public.sd_standard_cost_extra_fabric
               for all to authenticated using (public.sd_can_write()) with check (public.sd_can_write())';
  end if;
end $$;
