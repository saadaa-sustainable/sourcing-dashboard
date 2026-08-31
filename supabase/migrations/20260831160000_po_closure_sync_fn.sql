-- =====================================================================
-- PO Closure — completion detection (spec §5).
--
-- Completed POs (po_status_code=5) are NOT in sd_po_dashboard (Approved-only) and
-- authenticated has no direct grant on sd_po_master_raw, so this SECURITY DEFINER
-- function creates the closure rows: it stamps easycom_completed_at (= the PO's
-- last update date) so the SLA clock starts at completion, not at first view.
--
-- Scoped to the same SAADAA working-set filter as the dashboard view, and to a
-- rolling 45-day window (3× the 15-day SLA cap): the feature is forward-looking —
-- retro-creating rows for POs completed months ago would only add stale breaches.
-- Idempotent (on conflict do nothing); called on each PO Closure page load.
-- =====================================================================

create or replace function public.sd_sync_po_closures()
returns integer
language plpgsql
security definer
set search_path = ''
as $fn$
declare
  n integer;
begin
  with completed as (
    select po_ref_num, max(po_updated_date) as completed_on
      from public.sd_po_master_raw
     where po_status_code = 5
       and warehouse = 'SAADAA SUSTAINABLE DESIGNS AND TECHNOLOGIES PRIVATE LIMITED'
       and vendor_name not in (
         'SAADAA SUSTAINABLE DESIGNS AND TECHNOLOGIES PRIVATE LIMITED', 'EBO001', 'Holisol - BLR',
         'Marketing SAADAA', 'Defective Goods', 'SAADAA - GRN', 'HOLISOL-MH')
       and po_updated_date >= (current_date - 45)
     group by po_ref_num
  ), ins as (
    insert into public.sd_po_closure (po_ref_num, easycom_completed_at)
    select po_ref_num, completed_on::timestamptz from completed
    on conflict (po_ref_num) do nothing
    returning 1
  )
  select count(*) into n from ins;
  return n;
end;
$fn$;

grant execute on function public.sd_sync_po_closures() to authenticated;
