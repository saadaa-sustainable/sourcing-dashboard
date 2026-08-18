-- The sd_vendor_recommendation VIEW recomputed on every page load: full seq scans over
-- 169k GRN + 130k return + 64k PO rows (~4s warm, worse cold), intermittently tripping the
-- PostgREST statement timeout and crashing the Vendor Recommendation page. The source data
-- only changes on the daily/twice-daily sync, so precompute it and refresh on a schedule.

create extension if not exists pg_cron;

drop view if exists public.sd_vendor_recommendation;

create materialized view public.sd_vendor_recommendation as
 WITH po AS (
         SELECT sd_po_master_raw.po_id,
            COALESCE(NULLIF(btrim(max(sd_po_master_raw.vendor_code)), ''::text), NULLIF(btrim(max(sd_po_master_raw.vendor_name)), ''::text)) AS vendor_key,
            max(sd_po_master_raw.vendor_name) AS vendor_name,
            max(sd_po_master_raw.vendor_code) AS vendor_code,
            max(sd_po_master_raw.po_status_code) AS status_code,
            max(sd_po_master_raw.expected_delivery_date) AS edd,
            max(sd_po_master_raw.po_date) AS po_date
           FROM sd_po_master_raw
          WHERE sd_po_master_raw.po_date >= '2025-01-01'::date
          GROUP BY sd_po_master_raw.po_id
        ), grn AS (
         SELECT sd_po_grn_mapping.po_id::text AS po_id,
            max(sd_po_grn_mapping.grn_created_date) AS received
           FROM sd_po_grn_mapping
          WHERE sd_po_grn_mapping.grn_created_date IS NOT NULL
          GROUP BY sd_po_grn_mapping.po_id
        ), j AS (
         SELECT p.po_id, p.vendor_key, p.vendor_name, p.vendor_code, p.status_code, p.edd, p.po_date, g.received
           FROM po p
             LEFT JOIN grn g ON g.po_id = p.po_id
          WHERE p.vendor_key IS NOT NULL AND (lower(COALESCE(p.vendor_name, ''::text)) <> ALL (ARRAY['saadaa sustainable designs and technologies private limited'::text, 'ebo001'::text, 'holisol - blr'::text, 'marketing saadaa'::text, 'defective goods'::text, 'saadaa - grn'::text, 'holisol-mh'::text]))
        ), base AS (
         SELECT j.vendor_key,
            max(j.vendor_name) AS vendor_name,
            max(j.vendor_code) AS vendor_code,
            max(j.po_date) AS last_po_date,
            count(*) AS pos_given,
            count(*) FILTER (WHERE j.status_code = 5) AS pos_completed,
            count(*) FILTER (WHERE j.status_code = 5 AND j.edd IS NOT NULL AND j.received IS NOT NULL AND j.received <= j.edd) AS pos_on_time,
            count(*) FILTER (WHERE j.status_code = 5 AND j.edd IS NOT NULL AND j.received IS NOT NULL AND j.received > j.edd) AS pos_delayed,
            count(*) FILTER (WHERE j.status_code = 5 AND (j.edd IS NULL OR j.received IS NULL)) AS pos_completed_unrated,
            round(100.0 * count(*) FILTER (WHERE j.status_code = 5)::numeric / NULLIF(count(*), 0)::numeric, 1) AS completion_rate_pct,
            round(100.0 * count(*) FILTER (WHERE j.status_code = 5 AND j.edd IS NOT NULL AND j.received IS NOT NULL AND j.received <= j.edd)::numeric / NULLIF(count(*) FILTER (WHERE j.status_code = 5), 0)::numeric, 1) AS on_time_rate_pct,
            round(100.0 * count(*) FILTER (WHERE j.status_code = 5 AND j.edd IS NOT NULL AND j.received IS NOT NULL AND j.received > j.edd)::numeric / NULLIF(count(*) FILTER (WHERE j.status_code = 5), 0)::numeric, 1) AS delay_rate_pct
           FROM j
          GROUP BY j.vendor_key
        )
 SELECT base.vendor_key, base.vendor_name, base.vendor_code, base.last_po_date,
    base.pos_given, base.pos_completed, base.pos_on_time, base.pos_delayed, base.pos_completed_unrated,
    base.completion_rate_pct, base.on_time_rate_pct, base.delay_rate_pct,
    q.returned_items AS qc_returned_items, q.qc_fail_items, q.qc_fail_rate_pct,
    r.qc_checked AS grn_qc_checked, r.reject_rate_pct AS grn_reject_rate_pct
   FROM base
     LEFT JOIN sd_vendor_return_qc q ON q.vendor_key = base.vendor_key
     LEFT JOIN sd_vendor_grn_reject r ON r.vendor_key = base.vendor_key;

create unique index sd_vendor_recommendation_vendor_key_idx
  on public.sd_vendor_recommendation (vendor_key);

grant select on public.sd_vendor_recommendation to authenticated, service_role;

-- Manual refresh hook for the external backfill scripts. Plain REFRESH (not CONCURRENTLY)
-- so it is legal inside a function body; brief exclusive lock while it recomputes.
create or replace function public.refresh_vendor_recommendation()
returns void language sql security definer set search_path = public as $$
  refresh materialized view public.sd_vendor_recommendation;
$$;

-- Lock the refresh RPC to service_role only (SECURITY DEFINER funcs default to PUBLIC EXECUTE).
revoke execute on function public.refresh_vendor_recommendation() from public, anon, authenticated;
grant execute on function public.refresh_vendor_recommendation() to service_role;

-- Scheduled concurrent refresh ~1h after each sync window (IST 6AM/6PM = UTC 00:30/12:30).
select cron.schedule('refresh-vendor-recommendation-am', '30 1 * * *',
  $$refresh materialized view concurrently public.sd_vendor_recommendation$$);
select cron.schedule('refresh-vendor-recommendation-pm', '30 13 * * *',
  $$refresh materialized view concurrently public.sd_vendor_recommendation$$);
