-- Groups each returned/exchanged line-item's raw return_reason into a bucket.
-- Finding: ~99.8% of reasons are Unspecified or Undelivered(logistics) — neither
-- vendor-attributable — so return_reason is NOT a vendor-rating basis; the vendor
-- quality signal lives in inventory_status (see sd_vendor_return_qc). Kept for
-- return analytics. Only 'Product quality (vendor)' is flagged vendor-attributable.
create or replace view public.sd_return_reason_grouped
with (security_invoker = true) as
select
  row_key,
  credit_note_id,
  sku,
  return_date,
  case when replacement_order = 1 then 'exchange' else 'return' end as kind,
  return_reason,
  case
    when return_reason is null or btrim(return_reason) = '' or lower(return_reason) in ('other','others') then 'Unspecified'
    when lower(return_reason) like 'rto%' or lower(return_reason) like 'pickup not done%'
         or lower(return_reason) like 'not delivered%' or lower(return_reason) like 'zone/%'
         or lower(return_reason) like '%not serviceable%' then 'Undelivered (logistics)'
    when lower(return_reason) like '%damage%' or lower(return_reason) like '%expected better quality%'
         or lower(return_reason) like '%fake product%' or lower(return_reason) like '%defect%' then 'Product quality (vendor)'
    when lower(return_reason) like '%fit%' or lower(return_reason) like '%size%' then 'Fit / size'
    when lower(return_reason) like '%does not want%' or lower(return_reason) like '%by mistake%'
         or lower(return_reason) like '%cancelled%' or lower(return_reason) like '%did not like%' then 'Customer preference'
    when lower(return_reason) like 'exchange%' then 'Exchange-linked'
    when lower(return_reason) like '%wrong pic%' or lower(return_reason) like '%site policy%'
         or lower(return_reason) like '%complaint%' then 'Listing / catalog'
    else 'Unspecified'
  end as reason_group,
  (lower(coalesce(return_reason,'')) like '%damage%' or lower(coalesce(return_reason,'')) like '%expected better quality%'
   or lower(coalesce(return_reason,'')) like '%fake product%' or lower(coalesce(return_reason,'')) like '%defect%')
    as vendor_attributable
from public.sd_ee_return;
