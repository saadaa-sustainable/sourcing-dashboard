-- OOS Calculation = Main Warehouse only, for EVERY figure (user decision 2026-10-07).
-- The synced sd_oos_calculation takes the MAX of DOQ / OOS days / qty sold / price across all
-- warehouse rows and SUMS stock — so a STORE or Holisol row that never held stock (45 OOS days)
-- set the SKU's OOS days to 45 even when Main Warehouse had stock: 3,265 of 5,096 SKUs differed
-- from their Main Warehouse row. This view rebuilds every measure from the Main Warehouse row;
-- SKUs with no Main Warehouse row (39) drop out. Descriptive columns stay as synced.
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
             when 'doq_45' then format('m.doq_45::%s as doq_45', ty->>'doq_45')
             when 'total_oos_days' then format('m.oos_days_45::%s as total_oos_days', ty->>'total_oos_days')
             when 'total_inventory_days' then format('45::%s as total_inventory_days', ty->>'total_inventory_days')
             when 'total_available_days' then format('greatest(0, 45 - coalesce(m.oos_days_45, 0))::%s as total_available_days', ty->>'total_available_days')
             when 'total_qty_sold' then format('m.sold_45::%s as total_qty_sold', ty->>'total_qty_sold')
             when 'sales_value' then format('(case when m.sp > 0 then m.sp end)::%s as sales_value', ty->>'sales_value')
             when 'sales_leakage' then format('(coalesce(m.oos_days_45, 0) * coalesce(m.doq_45, 0) * coalesce(case when m.sp > 0 then m.sp end, 0))::%s as sales_leakage', ty->>'sales_leakage')
             when 'doh' then format('(case when coalesce(m.doq_45, 0) > 0 then round((m.stock / m.doq_45)::numeric, 1) end)::%s as doh', ty->>'doh')
             when 'doh_with_inprocess' then format('(case when coalesce(m.doq_45, 0) > 0 then round(((m.stock + coalesce(ip.in_process_qty, 0)) / m.doq_45)::numeric, 1) end)::%s as doh_with_inprocess', ty->>'doh_with_inprocess')
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
       left join public.sd_sku_in_process ip on ip.sku_key = m.sku_key',
    cols, '_', '', 'Main Warehouse', '_', '');
end $$;
comment on view public.sd_oos_calculation_main is
  'OOS calculation from the Main Warehouse row only: stock, DOQ 45, OOS days, qty sold, selling price, leakage, DOH; in process from approved POs. SKUs with no Main Warehouse row are left out.';
