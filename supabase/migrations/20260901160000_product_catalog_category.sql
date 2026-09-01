-- =====================================================================
-- Extend sd_product_catalog with category + sub_category (spec §2 Group By).
--
-- Group-By on the Buying Plan groups by garment category (Mahesh: "Top wear /
-- Bottom wear"), not product code. Those live on the EasyEcom master as
-- category_type (Top Wear / Bottom Wear / Dress / Bags) and sub_category (Shirt /
-- Pant / Kurta / …), case-inconsistent across SKUs. Roll up per code: one lateral
-- scan of the master computes the name (shortest-SKU match) + the dominant
-- canonicalised category / sub_category (mode over initcap(lower(trim(...)))).
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
  m.product_name,
  m.category,
  m.sub_category
from codes c
left join lateral (
  select
    (array_agg(g.product_name order by length(g.sku))
       filter (where coalesce(btrim(g.product_name), '') <> ''))[1] as product_name,
    mode() within group (order by initcap(lower(btrim(g.category_type))))
       filter (where coalesce(btrim(g.category_type), '') <> '') as category,
    mode() within group (order by initcap(lower(btrim(g.sub_category))))
       filter (where coalesce(btrim(g.sub_category), '') <> '') as sub_category
  from public.sd_ee_product_master g
  where g.sku like c.product_code || '%'
) m on true;

grant select on public.sd_product_catalog to authenticated;
