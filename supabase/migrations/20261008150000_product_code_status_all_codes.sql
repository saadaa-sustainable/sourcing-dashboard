-- Product state + weave per product code (sd_ee_product_code_status) — find EVERY product.
--
-- The stored rollup only knew product codes listed in sd_product_master or sd_active_variants,
-- so EasyEcom variants of any other product (SDBTJ, SDBWLP, SDFAK, SDLP, SMDPT, … — 20 codes on
-- the Aug–Oct FG plans) matched nothing and the Buying Plan showed Product State "—" and
-- Woven / Knitted "Unspecified" although the EasyEcom master has them (Ongoing / Knit).
--
-- Codes now also come from:
--   * sd_ee_product_master.category_name — EasyEcom keeps the parent product code there
--     (SDBTJ for SDBTJBE_2XL; true for 93% of SKUs), only where the SKU starts with it;
--   * every product code a buying plan line or a standard cost names.
-- Each SKU still goes to its LONGEST matching code, so no code that resolved before changes
-- (checked 2026-10-08: 59 → 116 codes, 0 existing codes changed). Temporary products with no
-- EasyEcom SKU stay unresolved, as they should (the page says "Not in EasyEcom yet").

drop view if exists public.sd_ee_product_code_status;
drop materialized view if exists public.sd_ee_product_code_status_mv;

create materialized view public.sd_ee_product_code_status_mv as
WITH codes AS MATERIALIZED (
  SELECT DISTINCT btrim(u.product_code) AS product_code
  FROM (
    SELECT product_code FROM public.sd_product_master
    UNION SELECT product_code FROM public.sd_active_variants
    -- EasyEcom keeps the parent product code in category_name (SDBTJ for SDBTJBE_2XL).
    UNION SELECT category_name FROM public.sd_ee_product_master
          WHERE length(btrim(category_name)) >= 4 AND sku LIKE btrim(category_name) || '%'
    -- Every code a plan or a standard cost names must resolve too.
    UNION SELECT product_code FROM public.sd_buying_plan_line
    UNION SELECT product_code FROM public.sd_standard_cost
  ) u
  WHERE u.product_code IS NOT NULL AND btrim(u.product_code) <> ''
), matched AS (
  SELECT (SELECT c.product_code FROM codes c
          WHERE g.sku LIKE c.product_code || '%'
          ORDER BY length(c.product_code) DESC LIMIT 1) AS product_code,
    CASE upper(btrim(regexp_replace(g.product_state, '\s+', ' ', 'g')))
      WHEN 'ONGOING' THEN 'Ongoing'
      WHEN 'NPD - NOT LAUNCHED YET' THEN 'NPD - Not Launched Yet'
      WHEN 'NPD' THEN 'NPD'
      WHEN 'TO BE DISCONTINUED' THEN 'To Be Discontinued'
      WHEN 'DISCONTINUED' THEN 'Discontinued'
      WHEN 'SKU CREATE BUT NOT LAUNCH' THEN 'SKU Create But Not Launch'
      WHEN '' THEN NULL
      ELSE initcap(btrim(g.product_state))
    END AS state,
    CASE
      WHEN upper(g.weave_type) = ANY (ARRAY['KNIT', 'KNITTED', 'TERRY']) THEN 'Knitted'
      WHEN upper(g.weave_type) LIKE '%WOVEN%' OR upper(g.weave_type) LIKE '%TWILL%' THEN 'Woven'
      ELSE NULL
    END AS norm_weave
  FROM public.sd_ee_product_master g
), ranked AS (
  SELECT product_code, state, norm_weave,
    CASE
      WHEN state IS NULL THEN 99
      WHEN state = 'Ongoing' THEN 1
      WHEN state = 'NPD' THEN 2
      WHEN state = 'NPD - Not Launched Yet' THEN 3
      WHEN state = 'SKU Create But Not Launch' THEN 4
      WHEN state = 'To Be Discontinued' THEN 5
      WHEN state = 'Discontinued' THEN 6
      ELSE 7
    END AS prio
  FROM matched
)
SELECT product_code,
  (array_agg(state ORDER BY prio))[1] AS product_status,
  mode() WITHIN GROUP (ORDER BY norm_weave) FILTER (WHERE norm_weave IS NOT NULL) AS fabric_type
FROM ranked
WHERE product_code IS NOT NULL
GROUP BY product_code
;

create unique index sd_ee_product_code_status_mv_pk on public.sd_ee_product_code_status_mv (product_code);
grant all on public.sd_ee_product_code_status_mv to authenticated, service_role;

create view public.sd_ee_product_code_status with (security_invoker = false) as
  select product_code, product_status, fabric_type
  from public.sd_ee_product_code_status_mv
  where (select public.sd_is_saadaa());
grant all on public.sd_ee_product_code_status to authenticated, service_role;

-- Stamp the refresh so the 'catalog' group does not rebuild it again straight away.
select * from public.sd_refresh_derived(true, 'catalog');
