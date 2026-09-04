-- =====================================================================
-- Vendor OTIF (On Time In Full) scorecard function — spec item 2.
--
-- Three separately-tracked TNA-compliance variables; this function computes two
-- of them per vendor (On-Time, In-Full) plus the joint OTIF pass rate. (The
-- third, Critical-Path/TNA-stage compliance, already lives on the Open PO
-- Tracker via isTnaHighRisk.)
--
--   • base = received POs (sd_po_grn_mapping) within the window (by last_grn_date)
--   • ordered = Σ po_original_quantity, received = Σ grn_receive_quantity per PO
--   • committed date = latest vendor commitment (sd_vendor_commitment_log, item 1)
--     ELSE the historical completed-PO EDD ELSE the GRN EDD
--   • on_time = actual delivery (last_grn_date) ≤ committed date
--   • in_full = received ≥ ordered
--   • OTIF   = on_time AND in_full  (joint pass/fail per PO, then aggregated)
--
-- NOTE: on-time/OTIF are provisional until the commitment log accumulates real
-- committed dates — the historical EDD fallback runs optimistic vs the final GRN,
-- so on-time currently reads low. Fill rate is meaningful now.
-- =====================================================================

create or replace function public.sd_vendor_otif(p_window_days integer default 180)
returns table (
  vendor_code text, vendor_name text,
  pos integer, on_time_pos integer, in_full_pos integer, otif_pos integer,
  on_time_pct numeric, fill_pct numeric, otif_pct numeric
)
language sql stable security definer set search_path = ''
as $$
  with cut as (
    select ((now() at time zone 'Asia/Kolkata')::date
            - make_interval(days => greatest(p_window_days, 1)))::date as d
  ),
  grn as (
    select po_ref_num,
      max(vendor_code) as vendor_code,
      max(vendor_name) as vendor_name,
      sum(po_original_quantity) as ordered_qty,
      sum(grn_receive_quantity) as received_qty,
      max(last_grn_date) as actual_delivery,
      max(case when expected_delivery_date ~ '^\d{4}-\d{2}-\d{2}'
              then expected_delivery_date::date end) as grn_edd
    from public.sd_po_grn_mapping
    where last_grn_date is not null
    group by po_ref_num
    having max(last_grn_date) >= (select d from cut)
  ),
  log as (
    select distinct on (po_ref_num) po_ref_num, coalesce(revised_date, committed_date) as committed
    from public.sd_vendor_commitment_log
    order by po_ref_num, id desc
  ),
  comp as (
    select po_ref_num, max(expected_delivery_date) as edd
    from public.sd_po_completed
    where expected_delivery_date is not null
    group by po_ref_num
  ),
  scored as (
    select
      coalesce(nullif(btrim(g.vendor_code), ''), upper(btrim(g.vendor_name))) as vkey,
      g.vendor_code as vcode, g.vendor_name as vname,
      (coalesce(l.committed, c.edd, g.grn_edd) is not null
        and g.actual_delivery <= coalesce(l.committed, c.edd, g.grn_edd)) as on_time,
      (g.ordered_qty > 0 and g.received_qty >= g.ordered_qty) as in_full
    from grn g
    left join log l using (po_ref_num)
    left join comp c using (po_ref_num)
  )
  select
    max(vcode) as vendor_code,
    max(vname) as vendor_name,
    count(*)::int as pos,
    count(*) filter (where on_time)::int as on_time_pos,
    count(*) filter (where in_full)::int as in_full_pos,
    count(*) filter (where on_time and in_full)::int as otif_pos,
    round(100.0 * count(*) filter (where on_time) / nullif(count(*), 0), 0) as on_time_pct,
    round(100.0 * count(*) filter (where in_full) / nullif(count(*), 0), 0) as fill_pct,
    round(100.0 * count(*) filter (where on_time and in_full) / nullif(count(*), 0), 0) as otif_pct
  from scored
  group by vkey
  having count(*) > 0;
$$;

revoke all on function public.sd_vendor_otif(integer) from public;
grant execute on function public.sd_vendor_otif(integer) to authenticated;
