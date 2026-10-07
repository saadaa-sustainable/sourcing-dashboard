-- Inventory scope (user decision 2026-10-07): every stock / demand / DOQ figure reads the Main
-- Warehouse only. FBA, STORE and Holisol rows (and rows with no warehouse) are left out — they
-- held ~33k pcs of stock, ~2% of 45-day sales, and their low DOQs dragged averages down.
-- Views only; the synced tables are unchanged.

-- 1. The inventory feed the derived views read: Main Warehouse rows only. sd_replenishment
--    (+ sd_replenishment_by_product), sd_variant_sales (+ sd_product_sales,
--    sd_npd_promotion_candidates, sd_receivable_plan), sd_inventory_by_product and sd_doq all
--    read this view, so they follow.
do $$
declare
  cols text;
begin
  select string_agg(
           case when column_name = 'total_inprogress'
                then $c$(case when p.warehouse = 'Main Warehouse' then round(coalesce(ip.in_process_qty, 0)) else 0 end)::bigint as total_inprogress$c$
                else format('p.%I', column_name) end,
           ', ' order by ordinal_position)
    into cols
  from information_schema.columns
  where table_schema = 'public' and table_name = 'sd_inventory_planning';
  execute format(
    'create or replace view public.sd_inventory_planning_po_ip with (security_invoker = true) as
       select %s from public.sd_inventory_planning p
       left join public.sd_sku_in_process ip on ip.sku_key = replace(upper(btrim(p.sku)), %L, %L)
       where p.warehouse = %L',
    cols, '_', '', 'Main Warehouse');
end $$;

-- 2. The OOS calculation as the pages read it: the synced sd_oos_calculation adds stock across
--    every warehouse and carries BigQuery's in-process; here current stock is the Main
--    Warehouse row, in process is the approved-PO figure, and both DOH columns are recomputed.
do $$
declare
  cols text;
  t_stock text;
  t_ip text;
  t_doh text;
  t_dohip text;
begin
  select format_type(atttypid, atttypmod) into t_stock from pg_attribute where attrelid = 'public.sd_oos_calculation'::regclass and attname = 'current_stock';
  select format_type(atttypid, atttypmod) into t_ip    from pg_attribute where attrelid = 'public.sd_oos_calculation'::regclass and attname = 'inprocess_stock';
  select format_type(atttypid, atttypmod) into t_doh   from pg_attribute where attrelid = 'public.sd_oos_calculation'::regclass and attname = 'doh';
  select format_type(atttypid, atttypmod) into t_dohip from pg_attribute where attrelid = 'public.sd_oos_calculation'::regclass and attname = 'doh_with_inprocess';
  select string_agg(
           case column_name
             when 'current_stock' then format('coalesce(m.stock, 0)::%s as current_stock', t_stock)
             when 'inprocess_stock' then format('coalesce(ip.in_process_qty, 0)::%s as inprocess_stock', t_ip)
             when 'doh' then format('(case when coalesce(o.doq_45, 0) > 0 then round((coalesce(m.stock, 0) / o.doq_45)::numeric, 1) end)::%s as doh', t_doh)
             when 'doh_with_inprocess' then format('(case when coalesce(o.doq_45, 0) > 0 then round(((coalesce(m.stock, 0) + coalesce(ip.in_process_qty, 0)) / o.doq_45)::numeric, 1) end)::%s as doh_with_inprocess', t_dohip)
             else format('o.%I', column_name)
           end,
           ', ' order by ordinal_position)
    into cols
  from information_schema.columns
  where table_schema = 'public' and table_name = 'sd_oos_calculation';
  execute format(
    'create or replace view public.sd_oos_calculation_main with (security_invoker = true) as
       select %s
       from public.sd_oos_calculation o
       left join (
         select replace(upper(btrim(sku)), %L, %L) as sku_key, sum(coalesce(current_stock, 0)) as stock
         from public.sd_inventory_planning
         where warehouse = %L
         group by 1
       ) m on m.sku_key = replace(upper(btrim(o.sku)), %L, %L)
       left join public.sd_sku_in_process ip on ip.sku_key = replace(upper(btrim(o.sku)), %L, %L)',
    cols, '_', '', 'Main Warehouse', '_', '', '_', '');
end $$;
comment on view public.sd_oos_calculation_main is
  'sd_oos_calculation with current stock from the Main Warehouse only and in process from approved POs (sd_sku_in_process); DOH columns recomputed.';
