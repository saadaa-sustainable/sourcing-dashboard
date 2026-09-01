-- =====================================================================
-- sd_product_catalog — product_code → product_name, for the "Add Product" picker
-- on Standard Cost and Buying Plan (search by code or name).
--
-- The code universe is the same union the product-state roll-up uses
-- (sd_product_master ∪ sd_active_variants — the codes the Buying Plan lists). The
-- name is pulled from the EasyEcom product master by the standard sku LIKE code%
-- join (a code's SKUs are code+variant+size), taking the shortest-SKU match for a
-- stable label. security_invoker so the caller's RLS applies. Small (~60 codes).
-- =====================================================================

create or replace view public.sd_product_catalog
with (security_invoker = true) as
with codes as materialized (
  select distinct product_code from (
    select product_code from public.sd_product_master
    union
    select product_code from public.sd_active_variants
  ) u
  where product_code is not null and btrim(product_code) <> ''
)
select
  c.product_code,
  (
    select g.product_name
    from public.sd_ee_product_master g
    where g.sku like c.product_code || '%'
      and coalesce(btrim(g.product_name), '') <> ''
    order by length(g.sku) asc
    limit 1
  ) as product_name
from codes c;

grant select on public.sd_product_catalog to authenticated;
