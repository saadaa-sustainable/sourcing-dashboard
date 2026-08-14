-- Feeds the Vendor Recommendation screen. Same rate logic as
-- sd_vendor_po_performance, but sourced from the LIVE sd_po_master_raw (BigQuery
-- mirror of the same EasyEcom PO data) so the screen works before the direct
-- pull (sd_ee_po) is populated. TODO: swap the source to sd_ee_po once that pull
-- runs. On-time = goods received (max grn_created_date) on/before EDD.
create or replace view public.sd_vendor_recommendation
with (security_invoker = true) as
with po as (
  select
    po_id,
    coalesce(nullif(btrim(max(vendor_code)), ''), nullif(btrim(max(vendor_name)), '')) as vendor_key,
    max(vendor_name) as vendor_name,
    max(vendor_code) as vendor_code,
    max(po_status_code) as status_code,
    max(expected_delivery_date) as edd,
    max(po_date) as po_date
  from public.sd_po_master_raw
  where po_date >= '2025-01-01'
  group by po_id
),
grn as (
  select po_id::text as po_id, max(grn_created_date) as received
  from public.sd_po_grn_mapping
  where grn_created_date is not null
  group by po_id
),
j as (
  select p.*, g.received
  from po p
  left join grn g on g.po_id = p.po_id
  where p.vendor_key is not null
    and lower(coalesce(p.vendor_name, '')) <> all (array[
      'saadaa sustainable designs and technologies private limited',
      'ebo001', 'holisol - blr', 'marketing saadaa',
      'defective goods', 'saadaa - grn', 'holisol-mh'
    ])
)
select
  vendor_key,
  max(vendor_name) as vendor_name,
  max(vendor_code) as vendor_code,
  max(po_date)     as last_po_date,
  count(*)                                                                as pos_given,
  count(*) filter (where status_code = 5)                                as pos_completed,
  count(*) filter (where status_code = 5 and edd is not null and received is not null and received <= edd) as pos_on_time,
  count(*) filter (where status_code = 5 and edd is not null and received is not null and received >  edd) as pos_delayed,
  count(*) filter (where status_code = 5 and (edd is null or received is null))                            as pos_completed_unrated,
  round(100.0 * count(*) filter (where status_code = 5) / nullif(count(*), 0), 1)                          as completion_rate_pct,
  round(100.0 * count(*) filter (where status_code = 5 and edd is not null and received is not null and received <= edd)
        / nullif(count(*) filter (where status_code = 5), 0), 1)                                           as on_time_rate_pct,
  round(100.0 * count(*) filter (where status_code = 5 and edd is not null and received is not null and received > edd)
        / nullif(count(*) filter (where status_code = 5), 0), 1)                                           as delay_rate_pct
from j
group by vendor_key;
