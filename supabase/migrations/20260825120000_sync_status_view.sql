-- One row per data source: pipeline, row count, last refresh time. Powers the
-- Sync Health tab so users can see whether each feed is fresh (the 6 AM cron has
-- silently 401'd before, leaving tables stale).
create or replace view public.sd_sync_status
with (security_invoker = true) as
  select 'DOQ / inventory planning'::text as source, 'BigQuery - daily 6 AM'::text as pipeline,
         count(*)::bigint as rows, max(synced_at) as last_refreshed from public.sd_inventory_planning
  union all
  select 'PO + GRN mapping', 'BigQuery - daily 6 AM', count(*), max(synced_at) from public.sd_po_grn_mapping
  union all
  select 'Inbound QC (GRN)', 'BigQuery - daily 6 AM', count(*), max(synced_at) from public.sd_ee_grn
  union all
  select 'Product master (EasyEcom)', 'BigQuery - daily 6 AM', count(*), max(synced_at) from public.sd_ee_product_master
  union all
  select 'DOQ Calculation', 'BigQuery - daily 6 AM', count(*), max(synced_at) from public.sd_oos_calculation
  union all
  select 'PO master (raw)', 'BigQuery - daily 6 AM', count(*), null::timestamptz from public.sd_po_master_raw
  union all
  select 'Customer returns / exchanges', 'EasyEcom API', count(*), max(synced_at) from public.sd_ee_return
  union all
  select 'Sheet: ' || table_name, 'Google Sheet - ~5 min',
         (array_agg(rows_synced order by finished_at desc))[1]::bigint, max(finished_at)
  from public.sync_log group by table_name;

grant select on public.sd_sync_status to authenticated;
