-- Effective launch date (virtual-inventory interim solution). EasyCom has no native
-- "virtual inventory" signal for when a product's inventory life effectively began,
-- so DOQ/Replenishment can't tell how much REAL sales history a recently-launched
-- product has. This centralizes the agreed workaround from data EasyCom already gives:
--
--   effective_launch_date =
--     first_sale_date  if it exists AND is not earlier than first_grn_date
--                      (you can't sell before you receive — an earlier sale date is a
--                       data-quality anomaly, not a real launch signal)
--     else first_grn_date
--     else null        (no launch signal at all → "no launch data yet", never today)
--
-- First Sale Date has no source yet (no sales-transaction feed in Supabase — see
-- PENDENCY §C), so it is null for now and effective resolves to First GRN. The logic
-- is written so wiring a real first_sale_date later is a one-line change (the base CTE).
-- First GRN comes from sd_po_grn_mapping.grn_created_date; product_code is derived from
-- the GRN sku (`<variant>_<size>` → variant → drop the 2-char colour), the project's
-- standard SKU→code convention (validated: 87/90 derived codes match sd_product_catalog).
--
-- days_since_launch bakes in the divide-by-1 guard (max(1, today - launch)) so ANY
-- consumer using it as a denominator (daily-rate = qty / days_since_launch) is safe for
-- a product launched today. NOTE: today's DOQ (doq_45/doq_365) is pre-computed upstream
-- in BigQuery and every in-app DOH/rate division is already guarded — so this adds the
-- launch reference + flag, it does not fix a live divide-by-zero.
create or replace view public.sd_product_launch_date as
with grn as (
  select
    left(split_part(sku, '_', 1), greatest(1, length(split_part(sku, '_', 1)) - 2)) as product_code,
    min(grn_created_date) as first_grn_date
  from public.sd_po_grn_mapping
  where sku is not null and btrim(sku) <> '' and grn_created_date is not null
  group by 1
),
base as (
  select
    product_code,
    null::date as first_sale_date,   -- no sales-transaction feed yet; wire here when it lands
    first_grn_date
  from grn
  where product_code is not null and btrim(product_code) <> ''
),
resolved as (
  select
    product_code,
    first_sale_date,
    first_grn_date,
    case
      when first_sale_date is not null and first_grn_date is not null and first_sale_date >= first_grn_date
        then first_sale_date
      when first_sale_date is not null and first_grn_date is null
        then first_sale_date
      else first_grn_date
    end as effective_launch_date
  from base
)
select
  product_code,
  first_sale_date,
  first_grn_date,
  effective_launch_date,
  case
    when effective_launch_date is null then null
    else greatest(1, (current_date - effective_launch_date))
  end as days_since_launch
from resolved;

grant select on public.sd_product_launch_date to authenticated;
