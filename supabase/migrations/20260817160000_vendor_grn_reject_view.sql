-- Vendor inbound-QC rejection factor from sd_ee_grn (GRN QC dispositions).
-- reject_rate = qc_fail / (qc_pass + qc_fail) over QC-checked units, per vendor.
-- Vendor resolved via GRN line's purchase_order_detail_id -> sd_po_master_raw
-- (same vendor_key as sd_vendor_recommendation), falling back to the GRN's own
-- vendor_name. Note: most received units are qc_pending (QC is selective), so this
-- rate reflects the QC-checked subset — gate on qc_checked volume when using it.
create or replace view public.sd_vendor_grn_reject
with (security_invoker = true) as
with v as (
  select
    g.qc_pass, g.qc_fail, g.damaged, g.received_quantity,
    coalesce(nullif(btrim(p.vendor_code), ''), nullif(btrim(p.vendor_name), ''), nullif(btrim(g.vendor_name), '')) as vendor_key,
    coalesce(p.vendor_name, g.vendor_name) as vendor_name
  from public.sd_ee_grn g
  left join public.sd_po_master_raw p on p.po_detail_id = g.purchase_order_detail_id::text
  where g.grn_created_at >= '2025-01-01'
)
select
  vendor_key,
  max(vendor_name) as vendor_name,
  round(sum(qc_pass))                                         as qc_pass,
  round(sum(qc_fail))                                         as qc_fail,
  round(sum(damaged))                                         as damaged,
  round(sum(qc_pass + qc_fail))                               as qc_checked,
  round(sum(received_quantity))                              as received,
  round(100.0 * sum(qc_fail) / nullif(sum(qc_pass + qc_fail), 0), 2) as reject_rate_pct
from v
where vendor_key is not null
  and lower(btrim(coalesce(vendor_name, ''))) <> all (array[
    'saadaa sustainable designs and technologies private limited',
    'ebo001', 'holisol - blr', 'marketing saadaa',
    'defective goods', 'saadaa - grn', 'holisol-mh'
  ])
group by vendor_key;
