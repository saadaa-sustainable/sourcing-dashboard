-- Per-vendor PO performance for vendor recommendation, from 2025 onward.
--   Completion Rate = POs completed / POs given
--   On-Time Rate    = on-time completed / POs completed   (on-time = po_updated_date <= EDD)
--   Delay Rate      = delayed completed / POs completed
-- PO facts come from sd_ee_po (direct EasyEcom pull, all statuses). EDD is not
-- returned by that endpoint, so it is joined per-PO from sd_po_master_raw.
-- security_invoker so it honours the querying user's RLS (avoids the definer-view lint).
create or replace view public.sd_vendor_po_performance
with (security_invoker = true) as
with edd as (
  select po_id, max(expected_delivery_date) as edd
  from public.sd_po_master_raw
  where po_id is not null
  group by po_id
),
po as (
  select
    e.po_id,
    coalesce(nullif(btrim(e.vendor_code), ''), nullif(btrim(e.vendor_name), '')) as vendor_key,
    e.vendor_name,
    e.vendor_code,
    e.po_status_id,
    e.po_updated_date,
    d.edd
  from public.sd_ee_po e
  left join edd d on d.po_id = e.po_id::text
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
  count(*) filter (where po_status_id = 5 and edd is not null
                     and po_updated_date::date <= edd)             as pos_on_time,
  count(*) filter (where po_status_id = 5 and edd is not null
                     and po_updated_date::date > edd)              as pos_delayed,
  count(*) filter (where po_status_id = 5 and edd is null)         as pos_completed_no_edd,
  round(100.0 * count(*) filter (where po_status_id = 5)
        / nullif(count(*), 0), 1)                                  as completion_rate_pct,
  round(100.0 * count(*) filter (where po_status_id = 5 and edd is not null
                                   and po_updated_date::date <= edd)
        / nullif(count(*) filter (where po_status_id = 5), 0), 1)  as on_time_rate_pct,
  round(100.0 * count(*) filter (where po_status_id = 5 and edd is not null
                                   and po_updated_date::date > edd)
        / nullif(count(*) filter (where po_status_id = 5), 0), 1)  as delay_rate_pct
from po
group by vendor_key;
