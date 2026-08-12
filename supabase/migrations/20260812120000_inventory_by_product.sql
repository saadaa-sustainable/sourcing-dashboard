-- =====================================================================
-- Product-level inventory snapshot for the PO approval detail (DOQ / stock /
-- days-of-stock tab). sd_inventory_planning is keyed by product_variant
-- (= product_code + 2-char colour); this rolls it up to product_code.
-- =====================================================================

drop view if exists public.sd_inventory_by_product;
create view public.sd_inventory_by_product
  with (security_invoker = on) as
select
  case
    when length(product_variant) > 2 then left(product_variant, length(product_variant) - 2)
    else product_variant
  end                              as product_code,
  sum(current_stock)               as current_stock,
  sum(total_inprogress)            as total_inprogress,
  sum(daily_quantity)              as daily_quantity,
  round(avg(doq_45)::numeric, 1)   as doq_45
from public.sd_inventory_planning
where product_variant is not null and btrim(product_variant) <> ''
group by 1;

grant select on public.sd_inventory_by_product to authenticated;
