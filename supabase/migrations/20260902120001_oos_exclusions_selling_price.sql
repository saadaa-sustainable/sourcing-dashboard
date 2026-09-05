-- =====================================================================
-- OOS Calculation tab rework (spec 2026-09-02):
--
-- 7. sd_oos_sku_exclusion — team-managed list of SKUs excluded from the
--    OOS calculation view. @saadaa.in read; team/admin write (sd_can_write).
--
-- 3. Selling Price: sd_oos_calculation.sales_value was 100% empty (no
--    writer). It now holds the per-unit selling price, sourced from
--    sd_inventory_planning.shopify_sp (the actual Shopify selling price —
--    the product master only carries MRP, ~2× SP, kept as the app-side
--    fallback for SKUs with no shopify_sp). Backfilled here; BqSync.gs
--    oosAggregate writes it on every sync.
--
-- (4. Sales Leakage = Selling Price × DOQ × OOS Days and 2. launch-date
--  fallback are computed app-side from this + the product master.)
-- =====================================================================

create table public.sd_oos_sku_exclusion (
  sku       text primary key,
  reason    text,
  added_by  text,
  added_at  timestamptz not null default now()
);

alter table public.sd_oos_sku_exclusion enable row level security;
create policy "saadaa read sd_oos_sku_exclusion" on public.sd_oos_sku_exclusion
  for select to authenticated using (public.sd_is_saadaa());
create policy "writers manage sd_oos_sku_exclusion" on public.sd_oos_sku_exclusion
  for all to authenticated
  using (public.sd_can_write())
  with check (public.sd_can_write());
grant select, insert, update, delete on public.sd_oos_sku_exclusion to authenticated;

-- Backfill Selling Price from the live Shopify selling price.
update public.sd_oos_calculation o
set sales_value = sp.sp
from (
  select sku, max(shopify_sp) as sp
  from public.sd_inventory_planning
  where coalesce(shopify_sp, 0) > 0
  group by sku
) sp
where sp.sku = o.sku;
