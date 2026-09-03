-- =====================================================================
-- Widen sd_product_catalog to include EVERY EasyEcom product code.
--
-- The catalog (the "Add Product" picker on Buying Plan / Standard Cost) drew its
-- code universe only from sd_product_master ∪ sd_active_variants — the planning
-- tables. Live EasyEcom products with no planning row yet (e.g. SDFAK / SDLNS /
-- SDLS — all "Ongoing") were therefore un-addable. Add a third source: codes
-- derived from the EasyEcom master's product_variant (code = variant minus its
-- 2-char colour, the same rule BqSync's deriveSku uses). Name / category /
-- sub_category still come from the lateral scan, so they populate for the new
-- codes too. ~61 → ~109 codes.
-- =====================================================================

create or replace view public.sd_product_catalog
with (security_invoker = true) as
with codes as materialized (
  select distinct product_code from (
    select product_code from public.sd_product_master
    union
    select product_code from public.sd_active_variants
    union
    select case
             when length(btrim(product_variant)) > 2
               then left(btrim(product_variant), length(btrim(product_variant)) - 2)
             else btrim(product_variant)
           end
    from public.sd_ee_product_master
    where product_variant is not null and btrim(product_variant) <> ''
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
