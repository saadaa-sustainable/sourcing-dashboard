-- Canonical product → fabric relation, straight from Product Master (Mahesh: "the
-- product and the fabric used to make it can be figured out from the product master").
-- Each SKU carries rm_fabric_sku (the raw/greige fabric), which IS the fabric_code the
-- fabric-cost + per-fabric EFOB tables key on. Rolled up to product_code (greige is
-- colour-agnostic). Only an UNAMBIGUOUS single fabric is auto-usable — a product mapped
-- to more than one fabric (panelled/multi-fabric garments) returns fabric_code = null
-- and multi_fabric = true, so those are left to manual selection, never auto-guessed.
create or replace view public.sd_product_fabric as
with pm as (
  select
    left(split_part(sku, '_', 1), greatest(1, length(split_part(sku, '_', 1)) - 2)) as product_code,
    nullif(btrim(rm_fabric_sku), '') as fabric_code
  from public.sd_ee_product_master
  where rm_fabric_sku is not null and btrim(rm_fabric_sku) <> ''
),
agg as (
  select
    product_code,
    count(distinct fabric_code) as fabric_count,
    min(fabric_code) as any_fabric
  from pm
  where product_code is not null and btrim(product_code) <> ''
  group by product_code
)
select
  product_code,
  case when fabric_count = 1 then any_fabric else null end as fabric_code,
  fabric_count,
  (fabric_count > 1) as multi_fabric
from agg;

grant select on public.sd_product_fabric to authenticated;
