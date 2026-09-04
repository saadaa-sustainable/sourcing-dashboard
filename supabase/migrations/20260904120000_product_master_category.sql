-- Item 2 (mandatory category/sub-category at product-code level). Until now category
-- and sub_category existed ONLY as a computed rollup in the sd_product_catalog view
-- (mode() of EasyEcom's category_type/sub_category). That's fine for products that
-- come through EasyEcom, but there was no authoritative, editable, team-owned field —
-- and no way to categorise a product EasyEcom hasn't classified.
--
-- Add real columns on sd_product_master as the AUTHORITATIVE OVERRIDE, and recreate
-- sd_product_catalog to prefer them (coalesce over the EasyEcom mode). Every existing
-- consumer already reads the catalog view, so this repoints them all at once with no
-- consumer change and no parallel category concept. Columns stay nullable in the DB;
-- "mandatory at creation" is enforced in the Product Master editor. Not mass-backfilled
-- on purpose — EasyEcom keeps flowing for un-overridden codes, so this is reversible;
-- a hard freeze can be done later if the team wants it.
alter table public.sd_product_master add column if not exists category text;
alter table public.sd_product_master add column if not exists sub_category text;

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
  -- Authoritative team override (sd_product_master) wins; fall back to the EasyEcom
  -- mode when no override is set.
  coalesce(nullif(btrim(pm.category), ''), m.category)         as category,
  coalesce(nullif(btrim(pm.sub_category), ''), m.sub_category) as sub_category
from codes c
left join public.sd_product_master pm on pm.product_code = c.product_code
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
