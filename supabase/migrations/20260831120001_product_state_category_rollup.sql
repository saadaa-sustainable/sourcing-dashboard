-- =====================================================================
-- Product State — category-level roll-up rule (spec 2026-08-31).
--
-- "Product Status" is renamed to "Product State" in the UI and is sourced from
-- the (EasyEcom) product master. The Buying Plan lists a *category* (product
-- code) whose many SKUs each carry their own product_state, so we roll those SKU
-- states up to one state per code by a strict priority pick: the category shows
-- the highest-priority state present among its SKUs. Priority (highest first):
--
--   1. Ongoing
--   2. NPD
--   3. NPD - Not Launched Yet
--   4. SKU Create But Not Launch
--   5. To Be Discontinued
--   6. Discontinued
--
-- (so any Ongoing SKU still makes the whole category Ongoing). States are
-- canonicalised on case/whitespace only — operationally distinct states stay
-- apart ("To Be Discontinued" != "Discontinued", "NPD" != "NPD - Not Launched
-- Yet"). This replaces the previous mode() (most-common) roll-up, which hid
-- disagreement. Unstated (null) SKUs rank last; a code with no stated SKU stays
-- null. Weave/fabric_type keeps its mode() roll-up, unchanged.
-- =====================================================================

-- codes is MATERIALIZED: without it the correlated per-SKU subquery rescans
-- the code list (re-evaluating RLS quals) ~11K times under the authenticated
-- role — statement timeout on the dashboard. Materialized, RLS runs once and
-- each probe scans the ~60-row in-memory list (fast).
--
-- The code universe is the UNION of sd_product_master and sd_active_variants:
-- the Buying Plan lists codes from the latter, and codes present only there
-- (SDAPLK, SDBTJ, SDFCT, ...) were getting no Product State / weave even
-- though the EE master has their SKUs.
create or replace view public.sd_ee_product_code_status
with (security_invoker = true) as
with codes as materialized (
  select distinct product_code from (
    select product_code from public.sd_product_master
    union
    select product_code from public.sd_active_variants
  ) u
  where product_code is not null and btrim(product_code) <> ''
),
matched as (
  select
    (select c.product_code from codes c
      where g.sku like c.product_code || '%'
      order by length(c.product_code) desc
      limit 1) as product_code,
    -- Case/whitespace canonicalisation only; distinct states are preserved.
    case upper(btrim(regexp_replace(g.product_state, '\s+', ' ', 'g')))
      when 'ONGOING'                  then 'Ongoing'
      when 'NPD - NOT LAUNCHED YET'    then 'NPD - Not Launched Yet'
      when 'NPD'                       then 'NPD'
      when 'TO BE DISCONTINUED'        then 'To Be Discontinued'
      when 'DISCONTINUED'              then 'Discontinued'
      when 'SKU CREATE BUT NOT LAUNCH' then 'SKU Create But Not Launch'
      when ''                          then null
      else initcap(btrim(g.product_state))
    end as state,
    case
      when upper(g.weave_type) in ('KNIT', 'KNITTED', 'TERRY')                      then 'Knitted'
      when upper(g.weave_type) like '%WOVEN%' or upper(g.weave_type) like '%TWILL%' then 'Woven'
      else null
    end as norm_weave
  from public.sd_ee_product_master g
),
ranked as (
  select
    product_code, state, norm_weave,
    case
      when state is null                       then 99
      when state = 'Ongoing'                   then 1
      when state = 'NPD'                       then 2
      when state = 'NPD - Not Launched Yet'    then 3
      when state = 'SKU Create But Not Launch' then 4
      when state = 'To Be Discontinued'        then 5
      when state = 'Discontinued'              then 6
      else 7
    end as prio
  from matched
)
select
  product_code,
  (array_agg(state order by prio))[1] as product_status,
  mode() within group (order by norm_weave) filter (where norm_weave is not null) as fabric_type
from ranked
where product_code is not null
group by product_code;

grant select on public.sd_ee_product_code_status to authenticated;
