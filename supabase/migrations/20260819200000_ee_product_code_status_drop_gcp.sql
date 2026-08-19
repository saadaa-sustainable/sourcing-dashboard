-- Retire the GCP product master (sd_gcp_product_master, from
-- saadaa_consolidated_product_master) now that sd_ee_product_master carries the same
-- attributes. Rebuild the product-code status/weave rollup over sd_ee_product_master
-- (same normalization) so the Buying Plan keeps reading product_status + fabric_type.
create or replace view public.sd_ee_product_code_status
with (security_invoker = true) as
with codes as (
  select distinct product_code from public.sd_product_master
  where product_code is not null and btrim(product_code) <> ''
),
matched as (
  select
    (select c.product_code from codes c
      where g.sku like c.product_code || '%'
      order by length(c.product_code) desc
      limit 1) as product_code,
    case
      when upper(g.product_state) like '%DISCONTINUE%'                                       then 'Discontinued'
      when upper(g.product_state) like '%NPD%' or upper(g.product_state) like '%NOT LAUNCH%' then 'NPD-Not-Launched'
      when upper(g.product_state) like '%ONGOING%'                                            then 'Ongoing'
      when g.product_state is null or btrim(g.product_state) = ''                             then null
      else initcap(g.product_state)
    end as norm_status,
    case
      when upper(g.weave_type) in ('KNIT', 'KNITTED', 'TERRY')                                then 'Knitted'
      when upper(g.weave_type) like '%WOVEN%' or upper(g.weave_type) like '%TWILL%'           then 'Woven'
      else null
    end as norm_weave
  from public.sd_ee_product_master g
)
select
  product_code,
  mode() within group (order by norm_status) filter (where norm_status is not null) as product_status,
  mode() within group (order by norm_weave)  filter (where norm_weave  is not null) as fabric_type
from matched
where product_code is not null
group by product_code;

grant select on public.sd_ee_product_code_status to authenticated;

drop view if exists public.sd_gcp_product_code_status;
drop table if exists public.sd_gcp_product_master cascade;
