-- =====================================================================
-- Vendor + product-code capacity allocation (Vendor Capacity spec item 1).
--
-- Capacity entry currently exists only at vendor level (total machines/karigar).
-- This adds a per-vendor-per-product allocation: how much of a vendor's monthly
-- capacity is committed to a specific product. Unit confirmed 2026-09-04 =
-- ABSOLUTE pieces/month (not a % split). The sum of a vendor's allocations is
-- checked against their capacity_per_month in the UI — a visible warning, not a
-- hard block. Same live, per-row save pattern as the vendor-level fields.
-- =====================================================================

create table public.sd_vendor_product_capacity_allocation (
  id             bigint generated always as identity primary key,
  vendor_code    text not null,
  product_code   text not null,
  allocated_qty  numeric,            -- pieces/month allocated to this product
  entry_date     timestamptz not null default now(),
  entered_by     text,
  unique (vendor_code, product_code)
);
create index sd_vpca_vendor_idx on public.sd_vendor_product_capacity_allocation (vendor_code);

alter table public.sd_vendor_product_capacity_allocation enable row level security;
create policy "saadaa read sd_vpca" on public.sd_vendor_product_capacity_allocation
  for select to authenticated using (public.sd_is_saadaa());
create policy "team write sd_vpca" on public.sd_vendor_product_capacity_allocation
  for all to authenticated
  using (public.sd_can_write()) with check (public.sd_can_write());

grant select on public.sd_vendor_product_capacity_allocation to authenticated;
grant insert, update, delete on public.sd_vendor_product_capacity_allocation to authenticated;
