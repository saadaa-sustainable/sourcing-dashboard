-- Switch the vendor on-time/delay basis from po_updated_date to the GRN RECEIPT
-- date: on-time = goods fully received (max grn_created_date per PO, from
-- sd_po_grn_mapping) on/before EDD. po_updated_date is the PO's last-update
-- timestamp and badly overstated delay; the receipt date is the real delivery.
-- Drop + recreate (a column was renamed no_edd -> unrated, so replace won't do).
drop view if exists public.sd_vendor_po_performance;
create view public.sd_vendor_po_performance
with (security_invoker = true) as
with edd as (
  select po_id, max(expected_delivery_date) as edd
  from public.sd_po_master_raw
  where po_id is not null
  group by po_id
),
grn as (
  select po_id, max(grn_created_date) as received_date
  from public.sd_po_grn_mapping
  where grn_created_date is not null
  group by po_id
),
po as (
  select
    e.po_id,
    coalesce(nullif(btrim(e.vendor_code), ''), nullif(btrim(e.vendor_name), '')) as vendor_key,
    e.vendor_name,
    e.vendor_code,
    e.po_status_id,
    d.edd,
    g.received_date
  from public.sd_ee_po e
  left join edd d on d.po_id = e.po_id::text
  left join grn g on g.po_id = e.po_id
  where e.po_created_date >= '2025-01-01'
    and lower(btrim(coalesce(e.vendor_name, ''))) <> all (array[
      'saadaa sustainable designs and technologies private limited',
      'ebo001', 'holisol - blr', 'marketing saadaa',
      'defective goods', 'saadaa - grn', 'holisol-mh'
    ])
    and coalesce(nullif(btrim(e.vendor_code), ''), nullif(btrim(e.vendor_name), '')) is not null
)
select
  vendor_key,
  max(vendor_name) as vendor_name,
  max(vendor_code) as vendor_code,
  count(*)                                                          as pos_given,
  count(*) filter (where po_status_id = 5)                         as pos_completed,
  count(*) filter (where po_status_id = 5 and edd is not null and received_date is not null
                     and received_date <= edd)                     as pos_on_time,
  count(*) filter (where po_status_id = 5 and edd is not null and received_date is not null
                     and received_date > edd)                      as pos_delayed,
  count(*) filter (where po_status_id = 5 and (edd is null or received_date is null))
                                                                    as pos_completed_unrated,
  round(100.0 * count(*) filter (where po_status_id = 5)
        / nullif(count(*), 0), 1)                                  as completion_rate_pct,
  round(100.0 * count(*) filter (where po_status_id = 5 and edd is not null and received_date is not null
                                   and received_date <= edd)
        / nullif(count(*) filter (where po_status_id = 5), 0), 1)  as on_time_rate_pct,
  round(100.0 * count(*) filter (where po_status_id = 5 and edd is not null and received_date is not null
                                   and received_date > edd)
        / nullif(count(*) filter (where po_status_id = 5), 0), 1)  as delay_rate_pct
from po
group by vendor_key;
