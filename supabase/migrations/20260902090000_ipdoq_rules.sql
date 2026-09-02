-- =====================================================================
-- IPDOQ (Inventory-Planning DOQ) — replenishment demand-rate fix.
--
-- Spec (DOQ/Replenishment fixes, 2026-09-02), items 1-2 + 5 + 7 backfill:
--
--   raw_ipdoq = if oos_days_45 > threshold (default 30):
--                   max(doq_365, doq_45)     -- T-45 unreliable when mostly OOS
--               else:
--                   doq_45                   -- recent trend trusted when in stock
--   IPDOQ     = max(floor, raw_ipdoq)        -- floor default 0.25, IPDOQ ONLY
--
-- Why: DOQ-45 is the more relevant signal when trustworthy (recent, reflects
-- current demand) but unreliable when the product was OOS for a large chunk
-- of the window — 25 of 45 days OOS means the T-45 figure is built on
-- incomplete data, so fall back to the longer T-365 (or whichever is higher).
-- The 0.25 floor applies ONLY to the final IPDOQ — never to daily_demand,
-- t45_quantity, or any other DOQ figure.
--
-- Both judgement numbers live in the editable Rules Master
-- (sd_analytics_rule), NOT hardcoded: the view reads them live, so changing
-- them in the rules UI affects the next query without a redeploy. The floor
-- was historically hardcoded upstream (it exists nowhere in this repo or its
-- git history) and was once edited without review — codifying it here is the
-- fix for that governance gap.
--
-- rop_N now feeds from IPDOQ (was raw daily_demand — the gap the spec
-- flagged): rop_N = max(0, IPDOQ × N − current_stock − in_progress).
-- daily_demand stays exposed for reference/continuity.
--
-- Also (item 7): total_inventory_days / total_available_days on
-- sd_oos_calculation had NO writer anywhere in the pipeline (dropped in the
-- OOS port; upstream BQ has no such columns) — every row was NULL/0.
-- oos_days_45 is a 45-calendar-day window count (max observed = 45), so:
-- inventory days = 45, available days = 45 − OOS days. Backfilled here;
-- BqSync.gs now writes both on every sync.
-- =====================================================================

-- Item 5: the two IPDOQ judgement numbers, in the Rules Master.
insert into public.sd_analytics_rule (rule_key, value, label, description) values
  ('oos_day_threshold', 30, 'IPDOQ — OOS-day threshold (of 45)',
   'When a product was out of stock for MORE than this many days of the last 45, its 45-day DOQ is unreliable; IPDOQ falls back to the higher of DOQ-365 and DOQ-45. Otherwise DOQ-45 alone is trusted.'),
  ('ipdoq_floor', 0.25, 'IPDOQ — minimum daily rate (units/day)',
   'Floor applied to the final IPDOQ value only — never to daily demand or any other DOQ figure. Standing default 0.25; changes here are visible and reviewed, unlike the old upstream hardcode.')
on conflict (rule_key) do nothing;

-- Items 1-2: rebuild the replenishment views around IPDOQ.
drop view if exists public.sd_replenishment_by_product;
drop view if exists public.sd_replenishment;

create view public.sd_replenishment as
with rules as (
  select
    coalesce((select value from public.sd_analytics_rule where rule_key = 'oos_day_threshold'), 30)  as oos_thr,
    coalesce((select value from public.sd_analytics_rule where rule_key = 'ipdoq_floor'), 0.25)      as ipdoq_floor
),
base as (
  select
    product_variant,
    max(category)                          as product_code,
    max(product_name)                      as product_name,
    max(product_state)                     as product_state,
    round(sum(coalesce(current_stock, 0)))     as current_stock,
    round(sum(coalesce(total_inprogress, 0)))  as in_progress,
    round(sum(coalesce(nullif(daily_quantity, 0), t45_quantity / 45.0, 0))::numeric, 2) as daily_demand,
    round(avg(nullif(doq_45, 0))::numeric, 2)  as doq_45,
    round(avg(nullif(doq_365, 0))::numeric, 2) as doq_365,
    max(coalesce(oos_days_45, 0))              as oos_days_45,
    bool_or(coalesce(oos_days_45, 0) > 0)      as oos_flag
  from public.sd_inventory_planning
  where product_variant is not null and product_variant <> ''
  group by product_variant
),
calc as (
  select
    b.*,
    round(greatest(
      r.ipdoq_floor::numeric,
      coalesce(
        case when b.oos_days_45 > r.oos_thr
             then greatest(b.doq_365, b.doq_45)   -- greatest() skips NULLs
             else b.doq_45
        end, 0)
    ), 2) as ipdoq
  from base b cross join rules r
)
select
  product_variant, product_code, product_name, product_state,
  current_stock, in_progress, daily_demand,
  doq_45, doq_365, oos_days_45, oos_flag, ipdoq,
  greatest(0, round(ipdoq * 30 - current_stock::numeric - in_progress::numeric)) as rop_30,
  greatest(0, round(ipdoq * 60 - current_stock::numeric - in_progress::numeric)) as rop_60,
  greatest(0, round(ipdoq * 90 - current_stock::numeric - in_progress::numeric)) as rop_90
from calc;

create view public.sd_replenishment_by_product as
select
  product_code,
  round(sum(current_stock))    as current_stock,
  round(sum(in_progress))      as in_progress,
  round(sum(daily_demand), 2)  as daily_demand,
  round(sum(ipdoq), 2)         as ipdoq,
  round(sum(rop_30))           as rop_30,
  round(sum(rop_60))           as rop_60,
  round(sum(rop_90))           as rop_90,
  bool_or(oos_flag)            as oos_flag,
  count(*)                     as variant_count
from public.sd_replenishment
where product_code is not null and product_code <> ''
group by product_code;

grant select on public.sd_replenishment, public.sd_replenishment_by_product to authenticated;

-- Item 7 backfill: give the two orphaned columns their values (the ongoing
-- writer is BqSync.gs oosAggregate, fixed alongside this migration).
update public.sd_oos_calculation set
  total_inventory_days = 45,
  total_available_days = greatest(0, 45 - coalesce(total_oos_days, 0));
