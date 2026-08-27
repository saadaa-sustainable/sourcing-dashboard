-- Sync Health rework, two fixes:
--
-- 1. De-duplicate the BigQuery-fed tables. sync_log is written by BOTH the
--    5-min sheet sync (Code.gs / production-forms.gs) and the BigQuery Apps
--    Script sync (BqSync.gs). The old catch-all turned every sync_log
--    table_name into a "Sheet: X / Google Sheet - ~5 min" row, so the
--    BigQuery-fed tables (sd_ee_grn, sd_ee_product_master,
--    sd_inventory_planning, sd_po_grn_mapping, sd_oos_calculation,
--    sd_po_qty_manual_adjustment) appeared twice — and the mislabelled
--    duplicate went falsely "Stale" after the 1 h sheet threshold even though
--    a twice-daily BigQuery feed 7 h old is perfectly healthy.
--
-- 2. New fetched_from column: the precise origin object (BigQuery table,
--    Google Sheet tab, or API endpoint) and the Supabase table it lands in,
--    so "which table/sheet is this row actually pulling?" needs no code dig.
--
-- security_invoker stays OFF (see 20260826100000: per-row RLS checks while
-- counting 170k+ row tables pushed the view past the 8 s statement timeout).
-- The view exposes only counts and timestamps; access limited via grant.

drop view if exists public.sd_sync_status;

create view public.sd_sync_status
with (security_invoker = false) as
with sheet_log as (
  -- Latest sync_log entry per table, EXCLUDING the tables BqSync.gs logs —
  -- those are shown once below under their BigQuery pipeline instead.
  select table_name,
         (array_agg(rows_synced order by finished_at desc))[1]::bigint as rows,
         max(finished_at) as last_refreshed
  from public.sync_log
  where table_name not in (
    'sd_ee_product_master', 'sd_inventory_planning', 'sd_oos_calculation',
    'sd_po_grn_mapping', 'sd_ee_grn',
    'sd_po_qty_manual_adjustment', 'sd_po_qty_cutting_register')
  group by table_name
),
-- sync_log table_name -> which Google Sheet tab feeds it (from the CONFIG
-- blocks in Code.gs / production-forms.gs / discontinued-inventory.gs).
sheet_map(table_name, fetched_from) as (values
  ('pending_po_master',       '"Pending_PO_MASTER" tab → pending_po_master'),
  ('vendor_type_master',      '"Vendor_Type_Master" tab → vendor_type_master'),
  ('vendor_master_data',      '"Vendor Master Data" tab → vendor_master_data (vendor names from BQ MAPLEMONK.Easyecom_Saadaa_vendors)'),
  ('tna_tracker',             '"TNA Update" tab → tna_tracker'),
  ('po_details_form',         '"PO Details Form" tab → po_details_form'),
  ('pp_sample_form',          '"PP Sample Update Form" tab → pp_sample_form'),
  ('inline_qc_form',          '"IN-LINE & MID LINE QC FORM" tab → inline_qc_form'),
  ('pdi_form',                '"PRE-DISPATCH QC FORM" tab → pdi_form'),
  ('po_closure_form',         '"PO Closure Form responses" tab → po_closure_form'),
  ('gpt_form',                '"Lab_Reports" tab → gpt_form'),
  ('cutting_form',            '"Cutting Register" tab → cutting_form'),
  ('discontinued_inventory',  '"Discontinued Products - Available inventory view" tab → discontinued_inventory')
)
  select 'DOQ / inventory planning'::text as source,
         'BigQuery - daily 6 AM'::text as pipeline,
         count(*)::bigint as rows, max(synced_at) as last_refreshed,
         'MAPLEMONK.saadaa_inventory_planning → sd_inventory_planning'::text as fetched_from
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
  select 'PO master (raw)', 'BigQuery - manual backfill', count(*), null::timestamptz,
         'MAPLEMONK.EE_purchase_orders (+ po_items) → sd_po_master_raw'
  from public.sd_po_master_raw
  union all
  select 'Customer returns / exchanges', 'EasyEcom API', count(*), max(synced_at),
         'EasyEcom /orders/getAllReturns → sd_ee_return'
  from public.sd_ee_return
  union all
  select 'Sheet: ' || sl.table_name, 'Google Sheet - ~5 min', sl.rows, sl.last_refreshed,
         sm.fetched_from
  from sheet_log sl
  left join sheet_map sm on sm.table_name = sl.table_name;

grant select on public.sd_sync_status to authenticated;
