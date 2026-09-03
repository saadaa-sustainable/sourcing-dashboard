-- =====================================================================
-- Delivery Reliability metric rebuild (Stockout/Reliability spec item 2).
--
-- The old card computed a vendor's delay rate over a 60-day window from the
-- OPEN-PO tracker only (pending_po_master holds only 'approved'/open POs). A
-- typical PO lead time is itself 60-90 days, so a 60-day window rarely contains
-- enough resolved cycles; worse, completed POs leave pending_po_master entirely
-- (they move to sd_po_completed), so the count silently shrank as POs completed
-- — the source of the "3 vs 5" discrepancy.
--
-- This function computes reliability over a configurable window (default 180d =
-- 2 quarters, read from the Rules Master by the caller), combining:
--   • COMPLETED POs (sd_po_completed) whose completion (po_updated_date) is in
--     the window — late = completed after expected_delivery_date (final status);
--   • OPEN POs (pending_po_master) whose po_date is in the window — late = still
--     open past expected_delivery_date.
-- A PO that flipped open→completed mid-window is counted ONCE (completed wins:
-- open rows whose po_number is already completed are excluded), fixing the
-- double-count. Vendor identity = vendor_code when present, else upper(name),
-- so a vendor can't split across a code/name mismatch.
-- =====================================================================

create or replace function public.sd_vendor_reliability(p_window_days integer default 180)
returns table (
  vendor_code    text,
  vendor_name    text,
  completed_pos  integer,
  open_pos       integer,
  total_pos      integer,
  delayed_pos    integer,
  delay_pct      numeric
)
language sql
stable
security definer
set search_path = ''
as $$
  with cut as (
    select ((now() at time zone 'Asia/Kolkata')::date
            - make_interval(days => greatest(p_window_days, 1)))::date as d
  ),
  comp as (  -- completed POs, one row per PO
    select
      coalesce(nullif(btrim(vendor_code), ''), upper(btrim(vendor_name))) as vkey,
      max(vendor_code) as vcode,
      max(vendor_name) as vname,
      po_number,
      bool_or(po_updated_date > expected_delivery_date) as late
    from public.sd_po_completed
    where po_updated_date is not null
      and expected_delivery_date is not null
      and po_updated_date >= (select d from cut)
    group by 1, po_number
  ),
  opn as (  -- open POs not already counted as completed
    select
      coalesce(nullif(btrim(vendor_code), ''), upper(btrim(vendor_name))) as vkey,
      max(vendor_code) as vcode,
      max(vendor_name) as vname,
      po_number,
      bool_or(expected_delivery_date is not null
              and expected_delivery_date < (now() at time zone 'Asia/Kolkata')::date) as late
    from public.pending_po_master
    where po_date is not null
      and po_date >= (select d from cut)
      and po_number not in (select po_number from comp)
    group by 1, po_number
  ),
  allpos as (
    select vkey, vcode, vname, 'C' as src, late from comp
    union all
    select vkey, vcode, vname, 'O' as src, late from opn
  )
  select
    max(vcode) as vendor_code,
    max(vname) as vendor_name,
    count(*) filter (where src = 'C')::int as completed_pos,
    count(*) filter (where src = 'O')::int as open_pos,
    count(*)::int as total_pos,
    count(*) filter (where late)::int as delayed_pos,
    round(100.0 * count(*) filter (where late) / nullif(count(*), 0), 0) as delay_pct
  from allpos
  group by vkey
  having count(*) > 0;
$$;

revoke all on function public.sd_vendor_reliability(integer) from public;
grant execute on function public.sd_vendor_reliability(integer) to authenticated;

-- Reliability window minimum is 2 quarters, not 60 days (editable in Rules Master).
update public.sd_analytics_rule
set value = 180,
    label = 'Vendor reliability window (days)',
    description = 'Rolling window for delivery-reliability (completed + open POs). '
                  || 'Min 2 quarters (~180d) — a 60-day window rarely holds enough resolved PO cycles.'
where rule_key = 'reliability_window_days';
