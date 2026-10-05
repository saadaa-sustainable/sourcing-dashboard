-- Store the slow calculations instead of redoing them on every read.
--
-- Pattern: the heavy part lives in a materialized view (*_mv); the public view keeps its old
-- name and columns and reads the stored result, so no page code changes. Anything that depends
-- on today's date stays computed in the thin view on top.
--
-- Measured before (ms per read): sd_grn_value 1125, sd_cash_flow_by_month 127 (sits on
-- sd_grn_value), sd_product_launch_date 113, sd_sync_status 973.

-- ── GRN value per GRN (sd_po_grn_mapping, 90k rows → 12.5k GRNs) ─────────────────────────────
create materialized view if not exists public.sd_grn_value_mv as
  select grn_id,
         max(vendor_code)       as vendor_code,
         max(vendor_name)       as vendor_name,
         max(po_type)           as po_type,
         max(grn_invoice_date)  as grn_invoice_date,
         max(grn_created_date)  as grn_created_date,
         round(max(total_grn_value))::numeric as grn_value
    from public.sd_po_grn_mapping
   where grn_id is not null and total_grn_value > 0
   group by grn_id;
create unique index if not exists sd_grn_value_mv_pk on public.sd_grn_value_mv (grn_id);

create or replace view public.sd_grn_value as
  select grn_id, vendor_code, vendor_name, po_type, grn_invoice_date, grn_created_date, grn_value
    from public.sd_grn_value_mv;

-- ── First GRN date per product (the launch date) ───────────────────────────────────────────
create materialized view if not exists public.sd_product_first_grn_mv as
  select left(split_part(sku, '_', 1), greatest(1, length(split_part(sku, '_', 1)) - 2)) as product_code,
         min(grn_created_date) as first_grn_date
    from public.sd_po_grn_mapping
   where sku is not null and btrim(sku) <> '' and grn_created_date is not null
   group by 1;
create unique index if not exists sd_product_first_grn_mv_pk on public.sd_product_first_grn_mv (product_code);

-- days_since_launch depends on today, so it stays computed here, on 95 stored rows.
create or replace view public.sd_product_launch_date as
  with base as (
    select product_code, null::date as first_sale_date, first_grn_date
      from public.sd_product_first_grn_mv
     where product_code is not null and btrim(product_code) <> ''
  ), resolved as (
    select product_code, first_sale_date, first_grn_date,
           case
             when first_sale_date is not null and first_grn_date is not null and first_sale_date >= first_grn_date then first_sale_date
             when first_sale_date is not null and first_grn_date is null then first_sale_date
             else first_grn_date
           end as effective_launch_date
      from base
  )
  select product_code, first_sale_date, first_grn_date, effective_launch_date,
         case when effective_launch_date is null then null::integer
              else greatest(1, current_date - effective_launch_date) end as days_since_launch
    from resolved;

-- Stored results are read through the views only.
revoke all on public.sd_grn_value_mv, public.sd_product_first_grn_mv from anon, authenticated;
grant select on public.sd_grn_value_mv, public.sd_product_first_grn_mv to service_role;

-- ── Refresh when the source has moved, not on a clock alone ─────────────────────────────────
create table if not exists public.sd_derived_refresh (
  name           text primary key,
  source_synced  timestamptz,
  refreshed_at   timestamptz,
  took_ms        int
);
alter table public.sd_derived_refresh enable row level security;
drop policy if exists sd_derived_refresh_read on public.sd_derived_refresh;
create policy sd_derived_refresh_read on public.sd_derived_refresh for select to authenticated using (public.sd_is_saadaa());

create or replace function public.sd_refresh_derived(force boolean default false)
returns table (name text, refreshed boolean, took_ms int)
language plpgsql
security definer
set search_path = public
as $$
declare
  src  timestamptz := (select max(synced_at) from public.sd_po_grn_mapping);
  last timestamptz;
  t0   timestamptz;
  mv   text;
begin
  foreach mv in array array['sd_grn_value_mv', 'sd_product_first_grn_mv'] loop
    select r.source_synced into last from public.sd_derived_refresh r where r.name = mv;
    if force or last is null or src is distinct from last then
      t0 := clock_timestamp();
      execute format('refresh materialized view concurrently public.%I', mv);
      took_ms := (extract(epoch from clock_timestamp() - t0) * 1000)::int;
      insert into public.sd_derived_refresh as d (name, source_synced, refreshed_at, took_ms)
      values (mv, src, now(), took_ms)
      on conflict on constraint sd_derived_refresh_pkey do update set source_synced = excluded.source_synced,
                                       refreshed_at  = excluded.refreshed_at,
                                       took_ms       = excluded.took_ms;
      name := mv; refreshed := true; return next;
    else
      name := mv; refreshed := false; took_ms := 0; return next;
    end if;
  end loop;
end;
$$;
revoke all on function public.sd_refresh_derived(boolean) from public, anon, authenticated;

-- Every 10 minutes; a no-op (one indexed max) unless the GRN mapping sync has written since.
select cron.unschedule(jobid) from cron.job where jobname = 'refresh-derived';
select cron.schedule('refresh-derived', '*/10 * * * *', 'select public.sd_refresh_derived()');

-- ── sd_sync_status: keep it live, make it fast ─────────────────────────────────────────────
-- 2/3 of its time was sorting all of sync_log (171k rows) to find each table's latest run.
-- An index plus a skip-scan over the ~17 table names does the same in a few lookups.
create index if not exists sync_log_table_finished_idx on public.sync_log (table_name, finished_at desc);
-- Row counts + freshness read through index-only scans instead of whole-table scans.
create index if not exists sd_ee_return_synced_idx        on public.sd_ee_return (synced_at);
create index if not exists sd_ee_grn_synced_idx           on public.sd_ee_grn (synced_at);
create index if not exists sd_po_master_raw_ingested_idx  on public.sd_po_master_raw (ingested_at);

create or replace view public.sd_sync_status with (security_invoker = false) as
  with recursive names(table_name) as (
    (select table_name from public.sync_log order by table_name limit 1)
    union all
    select (select s.table_name from public.sync_log s where s.table_name > n.table_name order by s.table_name limit 1)
      from names n where n.table_name is not null
  ), sheet_log as (
    select n.table_name, l.rows_synced::bigint as rows, l.finished_at as last_refreshed
      from names n
      cross join lateral (
        select s.rows_synced, s.finished_at from public.sync_log s
         where s.table_name = n.table_name and s.finished_at is not null
         order by s.finished_at desc limit 1
      ) l
     where n.table_name is not null
       and n.table_name <> all (array['sd_ee_product_master', 'sd_inventory_planning', 'sd_oos_calculation',
                                      'sd_po_grn_mapping', 'sd_ee_grn', 'sd_po_qty_manual_adjustment',
                                      'sd_po_qty_cutting_register'])
  ), sheet_map(table_name, fetched_from) as (
    values ('pending_po_master', '"Pending_PO_MASTER" tab → pending_po_master'),
           ('vendor_type_master', '"Vendor_Type_Master" tab → vendor_type_master'),
           ('vendor_master_data', '"Vendor Master Data" tab → vendor_master_data (vendor names from BQ MAPLEMONK.Easyecom_Saadaa_vendors)'),
           ('tna_tracker', '"TNA Update" tab → tna_tracker'),
           ('po_details_form', '"PO Details Form" tab → po_details_form'),
           ('pp_sample_form', '"PP Sample Update Form" tab → pp_sample_form'),
           ('inline_qc_form', '"IN-LINE & MID LINE QC FORM" tab → inline_qc_form'),
           ('pdi_form', '"PRE-DISPATCH QC FORM" tab → pdi_form'),
           ('po_closure_form', '"PO Closure Form responses" tab → po_closure_form'),
           ('gpt_form', '"Lab_Reports" tab → gpt_form'),
           ('cutting_form', '"Cutting Register" tab → cutting_form'),
           ('discontinued_inventory', '"Discontinued Products - Available inventory view" tab → discontinued_inventory')
  )
  select 'DOQ / inventory planning'::text as source, 'BigQuery - daily 6 AM'::text as pipeline, count(*) as rows,
         max(synced_at) as last_refreshed, 'MAPLEMONK.saadaa_inventory_planning → sd_inventory_planning'::text as fetched_from
    from public.sd_inventory_planning
  union all
  select 'DOQ Calculation', 'BigQuery - daily 6 AM', count(*), max(synced_at),
         'MAPLEMONK.saadaa_inventory_planning (aggregated in Apps Script) → sd_oos_calculation'
    from public.sd_oos_calculation
  union all
  select 'PO + GRN mapping', 'BigQuery - 6 AM & 6 PM', count(*), max(synced_at),
         'MAPLEMONK.saadaa_po_grn_mapping → sd_po_grn_mapping'
    from public.sd_po_grn_mapping
  union all
  select 'Inbound QC (GRN)', 'BigQuery - daily 6 AM', count(*), max(synced_at),
         'MAPLEMONK.EE_grn_details + EE_grn_details_grn_items → sd_ee_grn'
    from public.sd_ee_grn
  union all
  select 'Product master (EasyEcom)', 'BigQuery - daily 6 AM', count(*), max(synced_at),
         'MAPLEMONK.Easyecom_new_product_master (+ custom fields) → sd_ee_product_master'
    from public.sd_ee_product_master
  union all
  select 'PO qty manual adjustment', 'BigQuery - daily 6 AM', count(*), max(synced_at),
         'MAPLEMONK.po_qty_manual_adjustment → sd_po_qty_manual_adjustment'
    from public.sd_po_qty_manual_adjustment
  union all
  select 'PO qty cutting register', 'BigQuery - daily 6 AM', count(*), max(synced_at),
         'MAPLEMONK.po_qty_cutting_register → sd_po_qty_cutting_register'
    from public.sd_po_qty_cutting_register
  union all
  select 'PO master (raw)', 'BigQuery - 6 AM & 6 PM', count(*), max(ingested_at),
         'MAPLEMONK.EE_purchase_orders (+ po_items) → sd_po_master_raw'
    from public.sd_po_master_raw
  union all
  select 'Customer returns / exchanges', 'EasyEcom API', count(*), max(synced_at),
         'EasyEcom /orders/getAllReturns → sd_ee_return'
    from public.sd_ee_return
  union all
  select 'Sheet: ' || sl.table_name, 'Google Sheet - ~5 min', sl.rows, sl.last_refreshed, sm.fetched_from
    from sheet_log sl
    left join sheet_map sm on sm.table_name = sl.table_name;
