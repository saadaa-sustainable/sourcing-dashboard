-- =====================================================================
-- sd_po_dashboard — the single PO source for the sourcing dashboard.
--
-- Derived from the GCP pipeline (sd_po_master_raw), filtered to the live
-- sourcing working set: Approved POs, created in the SAADAA warehouse, with the
-- internal / logistics / non-vendor accounts excluded. This reproduces exactly
-- the scope the pending_po_master Google Sheet used to carry (3,154 rows /
-- 107 POs), so the dashboard reads real pipeline data instead of the sheet.
--
-- A VIEW (not a table) so it always reflects the latest pipeline load — no
-- refresh step. Note: the source column is `warehouse` (the BigQuery export's
-- po_created_warehouse). po_type (FOB/EFOB/JOB) is not a GCP column but is
-- reliably encoded in po_ref_num (FY26-27/<TYPE>/<PRODUCT>/<VENDOR>-<SEQ>),
-- so it is derived here — 100% of rows resolve to FOB, EFOB or JOB.
-- =====================================================================

-- Speeds up the filter (Approved + warehouse) against the 64k raw rows.
create index if not exists sd_po_raw_status_wh_idx
  on public.sd_po_master_raw (po_status, warehouse);

drop view if exists public.sd_po_dashboard;
create view public.sd_po_dashboard as
select
  po_detail_id,
  po_id,
  po_number,
  po_ref_num,
  upper(split_part(po_ref_num, '/', 2)) as po_type,   -- derived: FOB | EFOB | JOB
  po_status_code,
  po_status,
  vendor_code,
  vendor_name,
  warehouse,
  sku,
  product_id,
  product_code,
  product_variant,
  size,
  product_description,
  original_qty::double precision           as original_qty,
  pending_qty::double precision            as pending_qty,
  item_price::double precision             as item_price,
  total_po_value::double precision         as total_po_value,
  po_date::date::text                      as po_date,
  po_updated_date,
  expected_delivery_date::date::text       as expected_delivery_date,
  ingested_at
from public.sd_po_master_raw
where po_status = 'Approved'
  and warehouse = 'SAADAA SUSTAINABLE DESIGNS AND TECHNOLOGIES PRIVATE LIMITED'
  and vendor_name not in (
    'SAADAA SUSTAINABLE DESIGNS AND TECHNOLOGIES PRIVATE LIMITED',
    'EBO001',
    'Holisol - BLR',
    'Marketing SAADAA',
    'Defective Goods',
    'SAADAA - GRN',
    'HOLISOL-MH'
  );

grant select on public.sd_po_dashboard to authenticated;
