-- =====================================================================
-- PO Approval PR1 (form correctness):
--   rate                 — the negotiated rate, filled alongside the cost sheet.
--   requested_total_days — the day-count as REQUESTED at submission (locked),
--                          not recalculated against the eventual approval date.
-- =====================================================================

alter table public.sd_po_approval add column if not exists rate                 numeric;
alter table public.sd_po_approval add column if not exists requested_total_days numeric;
