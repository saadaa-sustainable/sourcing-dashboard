-- QC-fail vendor factor: of the customer-returned items attributed to a vendor,
-- how many came back as a quality defect (inventory_status Damaged / Repair / any
-- fail/defect/scrap/reject). Vendor is attributed via the returned SKU -> the
-- most-recent PO that supplied that SKU (returns carry no vendor). From 2025.
create or replace view public.sd_vendor_return_qc
with (security_invoker = true) as
with sku_vendor as (
  select distinct on (sku)
    sku,
    coalesce(nullif(btrim(vendor_code), ''), nullif(btrim(vendor_name), '')) as vendor_key,
    vendor_name, vendor_code
  from public.sd_po_master_raw
  where sku is not null and sku <> ''
    and coalesce(nullif(btrim(vendor_code), ''), nullif(btrim(vendor_name), '')) is not null
  order by sku, po_date desc nulls last
),
r as (
  select
    sv.vendor_key, sv.vendor_name, sv.vendor_code,
    e.replacement_order,
    (lower(e.inventory_status) in ('damaged', 'repair', 'qc fail', 'scrap', 'rejected', 'defective')
      or e.inventory_status ilike '%fail%' or e.inventory_status ilike '%defect%') as is_defect
  from public.sd_ee_return e
  join sku_vendor sv on sv.sku = e.sku
  where e.return_date >= '2025-01-01'
    and lower(btrim(coalesce(sv.vendor_name, ''))) <> all (array[
      'saadaa sustainable designs and technologies private limited',
      'ebo001', 'holisol - blr', 'marketing saadaa',
      'defective goods', 'saadaa - grn', 'holisol-mh'
    ])
)
select
  vendor_key,
  max(vendor_name) as vendor_name,
  max(vendor_code) as vendor_code,
  count(*)                                       as returned_items,
  count(*) filter (where is_defect)              as qc_fail_items,
  count(*) filter (where replacement_order = 1)  as exchange_items,
  round(100.0 * count(*) filter (where is_defect) / nullif(count(*), 0), 2) as qc_fail_rate_pct
from r
group by vendor_key;
