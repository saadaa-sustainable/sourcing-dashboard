-- PO cycle-time KPI: add the vendor sign-off leg to sd_po_cycle_time. Sign-off reuses
-- date_of_po_sign (the DiGiO signed date) — no new column. days_to_sign /
-- total_cycle_days_signoff stay null until DiGiO signing is live. Recreated (not
-- replaced) because the column list changes order.
drop view if exists public.sd_po_cycle_time;
create view public.sd_po_cycle_time as
select
  id, po_ref_num, vendor_code, category,
  submitted_for_approval_at, approved_at, po_issued_at, date_of_po_sign,
  round((extract(epoch from (approved_at  - submitted_for_approval_at)) / 86400)::numeric, 1) as days_to_approve,
  round((extract(epoch from (po_issued_at - approved_at))               / 86400)::numeric, 1) as days_to_issue,
  round((extract(epoch from (po_issued_at - submitted_for_approval_at)) / 86400)::numeric, 1) as total_cycle_days,
  (date_of_po_sign - approved_at::date)               as days_to_sign,
  (date_of_po_sign - submitted_for_approval_at::date) as total_cycle_days_signoff
from public.sd_po_approval;

grant select on public.sd_po_cycle_time to authenticated;
