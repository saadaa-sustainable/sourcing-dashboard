-- =====================================================================
-- Single filtered PO base — apply the sourcing exclusions in ONE place so no
-- downstream view can drift. Previously only sd_po_dashboard carried the
-- warehouse + vendor exclusions; sd_po_lines_enriched / sd_po_in_process /
-- sd_po_completed / sd_po_actuals_by_product_month read the raw table directly,
-- so excluded vendors (EBO001, Defective Goods, Holisol…) leaked onto the
-- Inward Plan, vendor in-process load and Buying Plan actuals.
--
-- sd_po_filtered keeps ALL statuses but only SAADAA-warehouse, real-vendor rows;
-- every derived view now reads from it and keeps its own status condition.
-- =====================================================================

create or replace view public.sd_po_filtered as
select *
from public.sd_po_master_raw
where warehouse = 'SAADAA SUSTAINABLE DESIGNS AND TECHNOLOGIES PRIVATE LIMITED'
  and vendor_name not in (
    'SAADAA SUSTAINABLE DESIGNS AND TECHNOLOGIES PRIVATE LIMITED',
    'EBO001', 'Holisol - BLR', 'Marketing SAADAA', 'Defective Goods',
    'SAADAA - GRN', 'HOLISOL-MH'
  );
grant select on public.sd_po_filtered to authenticated;

-- In-process (Approved) lines → feeds sd_vendor_in_process.
create or replace view public.sd_po_in_process as
select po_detail_id, po_id, po_number, po_ref_num, po_status_code, po_status,
  vendor_code, vendor_name, warehouse, sku, product_id, product_code, product_variant,
  size, product_description, original_qty, pending_qty, item_price, total_po_value,
  po_date, po_updated_date, expected_delivery_date, ingested_at
from public.sd_po_filtered
where po_status_code = 3;

-- Completed lines.
create or replace view public.sd_po_completed as
select po_detail_id, po_id, po_number, po_ref_num, po_status_code, po_status,
  vendor_code, vendor_name, warehouse, sku, product_id, product_code, product_variant,
  size, product_description, original_qty, pending_qty, item_price, total_po_value,
  po_date, po_updated_date, expected_delivery_date, ingested_at
from public.sd_po_filtered
where po_status_code = 5;

-- Buying Plan actuals (issued = Approved + Completed).
create or replace view public.sd_po_actuals_by_product_month as
select product_code,
  date_trunc('month', po_date::timestamptz)::date as plan_month,
  sum(original_qty) as issued_qty,
  sum(original_qty * item_price) as issued_value,
  count(distinct po_id) as po_count
from public.sd_po_filtered
where po_date is not null and po_status_code = any(array[3, 5])
group by product_code, date_trunc('month', po_date::timestamptz);

-- Inward Plan lines (consumer filters status=3 + pending>0).
create or replace view public.sd_po_lines_enriched as
select po_detail_id, po_number, po_ref_num, po_status, po_status_code,
  vendor_code, vendor_name, product_code, product_variant, size, sku,
  product_description, original_qty, pending_qty, item_price, po_date, expected_delivery_date
from public.sd_po_filtered;

-- Main dashboard set (Approved only) now also reads the single filtered base.
create or replace view public.sd_po_dashboard as
select po_detail_id, po_id, po_number, po_ref_num,
  upper(split_part(po_ref_num, '/'::text, 2)) as po_type,
  po_status_code, po_status, vendor_code, vendor_name, warehouse,
  sku, product_id, product_code, product_variant, size, product_description,
  original_qty::double precision as original_qty,
  pending_qty::double precision as pending_qty,
  item_price::double precision as item_price,
  total_po_value::double precision as total_po_value,
  po_date::text as po_date,
  po_updated_date,
  expected_delivery_date::text as expected_delivery_date,
  ingested_at
from public.sd_po_filtered
where po_status = 'Approved';
