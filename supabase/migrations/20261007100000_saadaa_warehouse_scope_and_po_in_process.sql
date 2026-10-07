-- Data scope (decided 2026-10-07):
--  1. Everywhere our data carries a PO-created warehouse, only POs created under
--     'SAADAA SUSTAINABLE DESIGNS AND TECHNOLOGIES PRIVATE LIMITED' count. PO views already
--     kept to it (sd_po_filtered); GRN data and the vendor views did not. GRN lines that match
--     no PO (warehouse unknown) are left out.
--  2. "In process" is no longer BigQuery's saadaa_inventory_planning.total_inprogress (it ran
--     ~10x the open POs). It is the pending qty on approved POs from the team's PO query:
--       warehouse = SAADAA…, vendor not one of our own / internal accounts,
--       po_status = 'Approved', po_date > 2025-08-01.
--     Every view that read total_inprogress now reads this figure instead.
-- Views only: no table data changes. BqSync keeps loading the raw tables unchanged.

-- ---------------------------------------------------------------------------------------
-- 1. In process from approved POs, per SKU (keyed like the inventory feed: no underscore).
-- ---------------------------------------------------------------------------------------
create or replace view public.sd_sku_in_process with (security_invoker = true) as
select
  replace(upper(btrim(sku)), '_', '') as sku_key,
  sum(coalesce(pending_qty, 0))       as in_process_qty,
  count(*)                            as open_lines,
  count(distinct po_id)               as open_pos
from public.sd_po_master_raw
where warehouse = 'SAADAA SUSTAINABLE DESIGNS AND TECHNOLOGIES PRIVATE LIMITED'
  and coalesce(vendor_name, '') not in (
    'SAADAA SUSTAINABLE DESIGNS AND TECHNOLOGIES PRIVATE LIMITED', 'EBO001', 'Holisol - BLR',
    'Marketing SAADAA', 'Defective Goods', 'SAADAA - GRN', 'HOLISOL-MH', 'NEXSSYS Photoshoot Studio')
  and po_status = 'Approved'
  and po_date > '2025-08-01'
  and sku is not null and btrim(sku) <> ''
group by 1;
comment on view public.sd_sku_in_process is
  'In process per SKU = pending qty on approved POs (SAADAA warehouse, own/internal vendors excluded, po_date > 2025-08-01). Replaces BigQuery total_inprogress.';

-- The inventory feed with total_inprogress swapped for the PO figure. In process is a SKU
-- figure, so it sits on the Main Warehouse row (where the feed carried it) and is 0 elsewhere
-- — sums across warehouse rows count it once.
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
       left join public.sd_sku_in_process ip on ip.sku_key = replace(upper(btrim(p.sku)), %L, %L)',
    cols, '_', '');
end $$;

-- Re-point every view that read the inventory feed's in-process column.
do $$
declare
  v text;
  def text;
  opts text[];
begin
  foreach v in array array['sd_replenishment', 'sd_variant_sales', 'sd_inventory_by_product', 'sd_doq'] loop
    select pg_get_viewdef(format('public.%I', v)::regclass, true), c.reloptions
      into def, opts
      from pg_class c where c.oid = format('public.%I', v)::regclass;
    def := regexp_replace(def, '\msd_inventory_planning\M', 'sd_inventory_planning_po_ip', 'g');
    execute format('create or replace view public.%I as %s', v, def);
    if opts is not null then
      execute format('alter view public.%I set (%s)', v, array_to_string(opts, ', '));
    end if;
  end loop;
end $$;

-- ---------------------------------------------------------------------------------------
-- 2. SAADAA warehouse scope on PO and GRN data.
-- ---------------------------------------------------------------------------------------

-- PO views: add the photoshoot studio account to the excluded vendors (matches the team's query).
create or replace view public.sd_po_filtered as
select po_detail_id, po_id, po_number, po_ref_num, po_status_code, po_status, vendor_code, vendor_name,
       warehouse, sku, product_id, product_code, product_variant, size, product_description,
       original_qty, pending_qty, item_price, total_po_value, po_date, po_updated_date,
       expected_delivery_date, ingested_at
from public.sd_po_master_raw
where warehouse = 'SAADAA SUSTAINABLE DESIGNS AND TECHNOLOGIES PRIVATE LIMITED'
  and vendor_name <> all (array[
    'SAADAA SUSTAINABLE DESIGNS AND TECHNOLOGIES PRIVATE LIMITED', 'EBO001', 'Holisol - BLR',
    'Marketing SAADAA', 'Defective Goods', 'SAADAA - GRN', 'HOLISOL-MH', 'NEXSSYS Photoshoot Studio']);

-- EasyEcom GRN lines for SAADAA-warehouse POs only (a GRN line with no PO on record is left out:
-- its warehouse cannot be confirmed). The app reads GRN through this view.
create or replace view public.sd_ee_grn_saadaa with (security_invoker = true) as
select g.*
from public.sd_ee_grn g
where exists (
  select 1 from public.sd_po_master_raw p
  where p.po_detail_id = g.purchase_order_detail_id::text
    and p.warehouse = 'SAADAA SUSTAINABLE DESIGNS AND TECHNOLOGIES PRIVATE LIMITED');
comment on view public.sd_ee_grn_saadaa is 'sd_ee_grn limited to GRN lines of POs created under the SAADAA warehouse (unmatched lines left out).';

-- Vendor GRN reject rate: SAADAA-warehouse POs only.
create or replace view public.sd_vendor_grn_reject with (security_invoker = true) as
with v as (
  select g.qc_pass, g.qc_fail, g.damaged, g.received_quantity,
         coalesce(nullif(btrim(p.vendor_code), ''), nullif(btrim(p.vendor_name), ''), nullif(btrim(g.vendor_name), '')) as vendor_key,
         coalesce(p.vendor_name, g.vendor_name) as vendor_name
  from public.sd_ee_grn g
  join public.sd_po_master_raw p on p.po_detail_id = g.purchase_order_detail_id::text
  where g.grn_created_at >= '2025-01-01'::date
    and p.warehouse = 'SAADAA SUSTAINABLE DESIGNS AND TECHNOLOGIES PRIVATE LIMITED'
)
select vendor_key,
       max(vendor_name) as vendor_name,
       round(sum(qc_pass)) as qc_pass,
       round(sum(qc_fail)) as qc_fail,
       round(sum(damaged)) as damaged,
       round(sum(qc_pass + qc_fail)) as qc_checked,
       round(sum(received_quantity)) as received,
       round(100.0 * sum(qc_fail) / nullif(sum(qc_pass + qc_fail), 0::numeric), 2) as reject_rate_pct
from v
where vendor_key is not null
  and lower(btrim(coalesce(vendor_name, ''))) <> all (array[
    'saadaa sustainable designs and technologies private limited', 'ebo001', 'holisol - blr',
    'marketing saadaa', 'defective goods', 'saadaa - grn', 'holisol-mh', 'nexssys photoshoot studio'])
group by vendor_key;

-- Customer-return QC by vendor: a SKU's vendor is read from SAADAA-warehouse POs only.
create or replace view public.sd_vendor_return_qc with (security_invoker = true) as
with sku_vendor as (
  select distinct on (m.sku) m.sku,
         coalesce(nullif(btrim(m.vendor_code), ''), nullif(btrim(m.vendor_name), '')) as vendor_key,
         m.vendor_name, m.vendor_code
  from public.sd_po_master_raw m
  where m.sku is not null and m.sku <> ''
    and m.warehouse = 'SAADAA SUSTAINABLE DESIGNS AND TECHNOLOGIES PRIVATE LIMITED'
    and coalesce(nullif(btrim(m.vendor_code), ''), nullif(btrim(m.vendor_name), '')) is not null
  order by m.sku, m.po_date desc nulls last
), r as (
  select sv.vendor_key, sv.vendor_name, sv.vendor_code, e.replacement_order,
         (lower(e.inventory_status) = any (array['damaged', 'repair', 'qc fail', 'scrap', 'rejected', 'defective']))
           or e.inventory_status ilike '%fail%' or e.inventory_status ilike '%defect%' as is_defect
  from public.sd_ee_return e
  join sku_vendor sv on sv.sku = e.sku
  where e.return_date >= '2025-01-01'::date
    and lower(btrim(coalesce(sv.vendor_name, ''))) <> all (array[
      'saadaa sustainable designs and technologies private limited', 'ebo001', 'holisol - blr',
      'marketing saadaa', 'defective goods', 'saadaa - grn', 'holisol-mh', 'nexssys photoshoot studio'])
)
select vendor_key,
       max(vendor_name) as vendor_name,
       max(vendor_code) as vendor_code,
       count(*) as returned_items,
       count(*) filter (where is_defect) as qc_fail_items,
       count(*) filter (where replacement_order = 1) as exchange_items,
       round(100.0 * count(*) filter (where is_defect)::numeric / nullif(count(*), 0)::numeric, 2) as qc_fail_rate_pct
from r
group by vendor_key;

-- Vendor PO performance: SAADAA-warehouse POs and their receipts.
create or replace view public.sd_vendor_po_performance with (security_invoker = true) as
with edd as (
  select po_id, max(expected_delivery_date) as edd
  from public.sd_po_master_raw
  where po_id is not null and warehouse = 'SAADAA SUSTAINABLE DESIGNS AND TECHNOLOGIES PRIVATE LIMITED'
  group by po_id
), grn as (
  select po_id, max(grn_created_date) as received_date
  from public.sd_po_grn_mapping
  where grn_created_date is not null and po_created_warehouse = 'SAADAA SUSTAINABLE DESIGNS AND TECHNOLOGIES PRIVATE LIMITED'
  group by po_id
), po as (
  select e.po_id,
         coalesce(nullif(btrim(e.vendor_code), ''), nullif(btrim(e.vendor_name), '')) as vendor_key,
         e.vendor_name, e.vendor_code, e.po_status_id, d.edd, g.received_date
  from public.sd_ee_po e
  left join edd d on d.po_id = e.po_id::text
  left join grn g on g.po_id = e.po_id
  where e.po_created_date >= '2025-01-01 00:00:00+00'::timestamptz
    and e.po_created_warehouse = 'SAADAA SUSTAINABLE DESIGNS AND TECHNOLOGIES PRIVATE LIMITED'
    and lower(btrim(coalesce(e.vendor_name, ''))) <> all (array[
      'saadaa sustainable designs and technologies private limited', 'ebo001', 'holisol - blr',
      'marketing saadaa', 'defective goods', 'saadaa - grn', 'holisol-mh', 'nexssys photoshoot studio'])
    and coalesce(nullif(btrim(e.vendor_code), ''), nullif(btrim(e.vendor_name), '')) is not null
)
select vendor_key,
       max(vendor_name) as vendor_name,
       max(vendor_code) as vendor_code,
       count(*) as pos_given,
       count(*) filter (where po_status_id = 5) as pos_completed,
       count(*) filter (where po_status_id = 5 and edd is not null and received_date is not null and received_date <= edd) as pos_on_time,
       count(*) filter (where po_status_id = 5 and edd is not null and received_date is not null and received_date > edd) as pos_delayed,
       count(*) filter (where po_status_id = 5 and (edd is null or received_date is null)) as pos_completed_unrated,
       round(100.0 * count(*) filter (where po_status_id = 5)::numeric / nullif(count(*), 0)::numeric, 1) as completion_rate_pct,
       round(100.0 * count(*) filter (where po_status_id = 5 and edd is not null and received_date is not null and received_date <= edd)::numeric
             / nullif(count(*) filter (where po_status_id = 5), 0)::numeric, 1) as on_time_rate_pct,
       round(100.0 * count(*) filter (where po_status_id = 5 and edd is not null and received_date is not null and received_date > edd)::numeric
             / nullif(count(*) filter (where po_status_id = 5), 0)::numeric, 1) as delay_rate_pct
from po
group by vendor_key;

-- Stored results: rebuilt with the warehouse scope, swapped in under the same names so the
-- thin views on top keep working (build new → re-point thin view → drop old → rename).

-- GRN value per GRN.
create materialized view public.sd_grn_value_mv_w as
select grn_id,
       max(vendor_code) as vendor_code,
       max(vendor_name) as vendor_name,
       max(po_type) as po_type,
       max(grn_invoice_date) as grn_invoice_date,
       max(grn_created_date) as grn_created_date,
       round(max(total_grn_value))::numeric as grn_value
from public.sd_po_grn_mapping
where grn_id is not null and total_grn_value > 0::double precision
  and po_created_warehouse = 'SAADAA SUSTAINABLE DESIGNS AND TECHNOLOGIES PRIVATE LIMITED'
group by grn_id;
create unique index sd_grn_value_mv_w_pk on public.sd_grn_value_mv_w (grn_id);
do $$
declare def text;
begin
  def := regexp_replace(pg_get_viewdef('public.sd_grn_value'::regclass, true), '\msd_grn_value_mv\M', 'sd_grn_value_mv_w', 'g');
  execute 'create or replace view public.sd_grn_value as ' || def;
end $$;
drop materialized view public.sd_grn_value_mv;
alter materialized view public.sd_grn_value_mv_w rename to sd_grn_value_mv;
alter index public.sd_grn_value_mv_w_pk rename to sd_grn_value_mv_pk;

-- First GRN per product (launch date): first receipt into the SAADAA warehouse.
create materialized view public.sd_product_first_grn_mv_w as
select "left"(split_part(sku, '_', 1), greatest(1, length(split_part(sku, '_', 1)) - 2)) as product_code,
       min(grn_created_date) as first_grn_date
from public.sd_po_grn_mapping
where sku is not null and btrim(sku) <> '' and grn_created_date is not null
  and po_created_warehouse = 'SAADAA SUSTAINABLE DESIGNS AND TECHNOLOGIES PRIVATE LIMITED'
group by 1;
create unique index sd_product_first_grn_mv_w_pk on public.sd_product_first_grn_mv_w (product_code);
do $$
declare def text;
begin
  def := regexp_replace(pg_get_viewdef('public.sd_product_launch_date'::regclass, true), '\msd_product_first_grn_mv\M', 'sd_product_first_grn_mv_w', 'g');
  execute 'create or replace view public.sd_product_launch_date as ' || def;
end $$;
drop materialized view public.sd_product_first_grn_mv;
alter materialized view public.sd_product_first_grn_mv_w rename to sd_product_first_grn_mv;
alter index public.sd_product_first_grn_mv_w_pk rename to sd_product_first_grn_mv_pk;

revoke all on public.sd_grn_value_mv, public.sd_product_first_grn_mv from anon, authenticated;
grant select on public.sd_grn_value_mv, public.sd_product_first_grn_mv to service_role;

-- Vendor recommendation (stored; refreshed by cron twice a day): SAADAA-warehouse POs + GRNs.
drop materialized view public.sd_vendor_recommendation;
create materialized view public.sd_vendor_recommendation as
with po as (
  select po_id,
         coalesce(nullif(btrim(max(vendor_code)), ''), nullif(btrim(max(vendor_name)), '')) as vendor_key,
         max(vendor_name) as vendor_name,
         max(vendor_code) as vendor_code,
         max(po_status_code) as status_code,
         max(expected_delivery_date) as edd,
         max(po_date) as po_date
  from public.sd_po_master_raw
  where po_date >= '2025-01-01'::date
    and warehouse = 'SAADAA SUSTAINABLE DESIGNS AND TECHNOLOGIES PRIVATE LIMITED'
  group by po_id
), grn as (
  select po_id::text as po_id, max(grn_created_date) as received
  from public.sd_po_grn_mapping
  where grn_created_date is not null
    and po_created_warehouse = 'SAADAA SUSTAINABLE DESIGNS AND TECHNOLOGIES PRIVATE LIMITED'
  group by po_id
), j as (
  select p.po_id, p.vendor_key, p.vendor_name, p.vendor_code, p.status_code, p.edd, p.po_date, g.received
  from po p
  left join grn g on g.po_id = p.po_id
  where p.vendor_key is not null
    and lower(coalesce(p.vendor_name, '')) <> all (array[
      'saadaa sustainable designs and technologies private limited', 'ebo001', 'holisol - blr',
      'marketing saadaa', 'defective goods', 'saadaa - grn', 'holisol-mh', 'nexssys photoshoot studio'])
), base as (
  select vendor_key,
         max(vendor_name) as vendor_name,
         max(vendor_code) as vendor_code,
         max(po_date) as last_po_date,
         count(*) as pos_given,
         count(*) filter (where status_code = 5) as pos_completed,
         count(*) filter (where status_code = 5 and edd is not null and received is not null and received <= edd) as pos_on_time,
         count(*) filter (where status_code = 5 and edd is not null and received is not null and received > edd) as pos_delayed,
         count(*) filter (where status_code = 5 and (edd is null or received is null)) as pos_completed_unrated,
         round(100.0 * count(*) filter (where status_code = 5)::numeric / nullif(count(*), 0)::numeric, 1) as completion_rate_pct,
         round(100.0 * count(*) filter (where status_code = 5 and edd is not null and received is not null and received <= edd)::numeric
               / nullif(count(*) filter (where status_code = 5), 0)::numeric, 1) as on_time_rate_pct,
         round(100.0 * count(*) filter (where status_code = 5 and edd is not null and received is not null and received > edd)::numeric
               / nullif(count(*) filter (where status_code = 5), 0)::numeric, 1) as delay_rate_pct
  from j
  group by vendor_key
)
select base.vendor_key, base.vendor_name, base.vendor_code, base.last_po_date, base.pos_given, base.pos_completed,
       base.pos_on_time, base.pos_delayed, base.pos_completed_unrated, base.completion_rate_pct,
       base.on_time_rate_pct, base.delay_rate_pct,
       q.returned_items as qc_returned_items, q.qc_fail_items, q.qc_fail_rate_pct,
       r.qc_checked as grn_qc_checked, r.reject_rate_pct as grn_reject_rate_pct
from base
left join public.sd_vendor_return_qc q on q.vendor_key = base.vendor_key
left join public.sd_vendor_grn_reject r on r.vendor_key = base.vendor_key;
create unique index sd_vendor_recommendation_vendor_key_idx on public.sd_vendor_recommendation (vendor_key);
revoke all on public.sd_vendor_recommendation from anon, authenticated;
grant select on public.sd_vendor_recommendation to service_role;
