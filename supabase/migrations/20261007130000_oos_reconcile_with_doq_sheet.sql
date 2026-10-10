-- OOS Dashboard reconciled with the team's DOQ sheet (2026-10-07). Total-row rules adopted
-- from the sheet (verified SKU by SKU against its 6 Oct tables):
--  * SKU universe = EasyEcom product master minus the exclusion list (not the BigQuery feed,
--    which lacks 395 of the team's SKUs). Compared on the app's SKU key, that is the team's
--    4,171 plus two raw-material codes, which join the exclusion list here.
--  * 45-day DOQ = 45-day qty sold / days sellable (sd_doq_window f45_*), OOS days = days not
--    sellable — both computed by BqSync from the Main Warehouse history (sellable = stock > 3).
--  * Sales leakage price = selling price × leakage_price_factor (0.85: the sheet's
--    "Sales Value of SKU" is SP × 0.85 for 3,242 of 3,764 SKUs).

-- 45-day window on the DOQ windows table (filled by BqSync doqWindows).
alter table public.sd_doq_window add column if not exists f45_qty double precision;
alter table public.sd_doq_window add column if not exists f45_avail integer;
alter table public.sd_doq_window add column if not exists f45_oos integer;

-- Leakage price factor (Rules Master).
insert into public.sd_analytics_rule (rule_key, value, label, description, updated_at, updated_by)
values ('leakage_price_factor', 0.85, 'Sales leakage price factor',
        'Sales leakage values a lost piece at selling price x this factor (the DOQ sheet uses 0.85).', now(), 'reconciliation')
on conflict (rule_key) do nothing;

-- Product-master codes that are not on the team's OOS SKU list: the two raw-material codes.
-- (Compared on the app's SKU key — letters and digits only — every other product-master SKU
-- outside the exclusion list is on the team's list.)
insert into public.sd_oos_sku_exclusion (sku, reason, added_by, added_at)
select pm.sku, 'Not on the OOS SKU list (7 Oct 2026)', 'reconciliation', now()
from public.sd_ee_product_master pm
where pm.sku in ('20CT/63/RM', '30RT/63/RM')
on conflict (sku) do nothing;

-- OOS calculation: DOQ 45 and OOS days from the 45-day window when it is there (else the feed's
-- Main Warehouse row), leakage at the factored price.
do $$
declare
  cols text;
  t record;
  ty jsonb := '{}'::jsonb;
begin
  for t in
    select attname, format_type(atttypid, atttypmod) ft from pg_attribute
    where attrelid = 'public.sd_oos_calculation'::regclass and attnum > 0 and not attisdropped
  loop
    ty := ty || jsonb_build_object(t.attname, t.ft);
  end loop;

  select string_agg(
           case column_name
             when 'product_status' then 'coalesce(m.product_state, o.product_status) as product_status'
             when 'current_stock' then format('m.stock::%s as current_stock', ty->>'current_stock')
             when 'inprocess_stock' then format('coalesce(ip.in_process_qty, 0)::%s as inprocess_stock', ty->>'inprocess_stock')
             when 'doq_45' then format('w.doq45::%s as doq_45', ty->>'doq_45')
             when 'total_oos_days' then format('w.oos45::%s as total_oos_days', ty->>'total_oos_days')
             when 'total_inventory_days' then format('45::%s as total_inventory_days', ty->>'total_inventory_days')
             when 'total_available_days' then format('w.avail45::%s as total_available_days', ty->>'total_available_days')
             when 'total_qty_sold' then format('w.qty45::%s as total_qty_sold', ty->>'total_qty_sold')
             when 'sales_value' then format('(case when m.sp > 0 then m.sp end)::%s as sales_value', ty->>'sales_value')
             when 'sales_leakage' then format('(coalesce(w.oos45, 0) * coalesce(w.doq45, 0) * coalesce(case when m.sp > 0 then m.sp end, 0) * (select coalesce((select value from public.sd_analytics_rule where rule_key = %L), 0.85)))::%s as sales_leakage', 'leakage_price_factor', ty->>'sales_leakage')
             when 'doh' then format('(case when coalesce(w.doq45, 0) > 0 then round((m.stock / w.doq45)::numeric, 1) end)::%s as doh', ty->>'doh')
             when 'doh_with_inprocess' then format('(case when coalesce(w.doq45, 0) > 0 then round(((m.stock + coalesce(ip.in_process_qty, 0)) / w.doq45)::numeric, 1) end)::%s as doh_with_inprocess', ty->>'doh_with_inprocess')
             else format('o.%I', column_name)
           end,
           ', ' order by ordinal_position)
    into cols
  from information_schema.columns
  where table_schema = 'public' and table_name = 'sd_oos_calculation';

  execute 'drop view if exists public.sd_oos_calculation_main';
  execute format(
    'create view public.sd_oos_calculation_main with (security_invoker = true) as
       select %s
       from public.sd_oos_calculation o
       join (
         select replace(upper(btrim(sku)), %L, %L) as sku_key,
                sum(coalesce(current_stock, 0))::numeric as stock,
                max(doq_45)::numeric as doq_45,
                max(oos_days_45)::numeric as oos_days_45,
                max(total_sales_in_last_45_inventory_days)::numeric as sold_45,
                max(shopify_sp)::numeric as sp,
                max(product_state) as product_state
         from public.sd_inventory_planning
         where warehouse = %L
         group by 1
       ) m on m.sku_key = replace(upper(btrim(o.sku)), %L, %L)
       left join (
         select replace(upper(btrim(sku)), %L, %L) as sku_key, f45_qty, f45_avail, f45_oos from public.sd_doq_window
       ) dw on dw.sku_key = m.sku_key
       cross join lateral (
         select
           case when dw.f45_avail is not null then (case when dw.f45_avail > 0 then dw.f45_qty / dw.f45_avail else 0 end) else m.doq_45 end::numeric as doq45,
           coalesce(dw.f45_oos, m.oos_days_45)::numeric as oos45,
           coalesce(dw.f45_avail, greatest(0, 45 - coalesce(m.oos_days_45, 0)))::numeric as avail45,
           coalesce(dw.f45_qty, m.sold_45)::numeric as qty45
       ) w
       left join public.sd_sku_in_process ip on ip.sku_key = m.sku_key',
    cols, '_', '', 'Main Warehouse', '_', '', '_', '');
end $$;
comment on view public.sd_oos_calculation_main is
  'OOS calculation, Main Warehouse only: stock from the Main row; DOQ 45 / OOS days / available days / qty sold from the 45-day window (sellable = stock > 3); leakage at SP x leakage_price_factor; in process from approved POs.';
