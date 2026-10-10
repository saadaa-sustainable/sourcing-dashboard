-- OOS calculation, the DOQ sheet's 45-day rules (verified SKU by SKU, 7 Oct 2026):
--   OOS days      = the feed's oos_days_45 (Main Warehouse row) — equals the sheet's "Total OOS
--                   Days" on all 3,776 shared SKUs (46,250 days, 1,812 SKUs).
--   available     = 45 − OOS days
--   qty sold      = the feed's t45_quantity
--   DOQ 45        = qty sold ÷ available days (the sheet: 9 sold, 4 OOS days → 9 ÷ 41 = 0.22);
--                   a SKU with NO sellable day in the 45 takes the Rules Master ipdoq_floor (0.25)
--                   — 681 of the sheet's 690 fully-OOS SKUs carry exactly 0.25
-- Replaces the 45-day window read from sd_doq_window: the feed's per-day current_stock is today's
-- stock repeated on every past day, so a day-by-day stock rule cannot see past stock-outs.
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
                max(product_state) as product_state,
                max(t45_quantity)::numeric as t45
         from public.sd_inventory_planning
         where warehouse = %L
         group by 1
       ) m on m.sku_key = replace(upper(btrim(o.sku)), %L, %L)
       cross join lateral (
         select
           (case when 45 - coalesce(m.oos_days_45, 0) > 0 then coalesce(m.t45, 0) / (45 - coalesce(m.oos_days_45, 0))
                 else (select coalesce((select value from public.sd_analytics_rule where rule_key = ''ipdoq_floor''), 0.25)) end)::numeric as doq45,
           coalesce(m.oos_days_45, 0)::numeric as oos45,
           greatest(0, 45 - coalesce(m.oos_days_45, 0))::numeric as avail45,
           coalesce(m.t45, 0)::numeric as qty45
       ) w
       left join public.sd_sku_in_process ip on ip.sku_key = m.sku_key',
    cols, '_', '', 'Main Warehouse', '_', '');
end $$;
comment on view public.sd_oos_calculation_main is
  'OOS calculation, Main Warehouse only, the DOQ sheet 45-day rules: OOS days = feed oos_days_45, DOQ 45 = t45_quantity / (45 - OOS days); leakage at SP x leakage_price_factor; in process from approved POs.';
