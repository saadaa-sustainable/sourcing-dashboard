-- =====================================================================
-- Extend the tna_tracker mirror to carry the richer "TNA Update" fields the
-- dashboard now models: First Delivery + PO Closer milestones, and the roll-ups
-- (GRN Qty, Pending Qty, Current Production Stage, Total Delay Days).
--
-- Must run BEFORE the extended mapTnaRow in apps-script/Code.gs is deployed —
-- otherwise the mirror upsert would fail on an unknown column.
-- =====================================================================

alter table public.tna_tracker
  add column if not exists first_delivery_tna_date    date,
  add column if not exists first_delivery_actual_date date,
  add column if not exists first_delivery_delay_days  integer,
  add column if not exists po_closer_tna_date         date,
  add column if not exists po_closer_actual_date      date,
  add column if not exists po_closer_delay_days       integer,
  add column if not exists grn_qty                    numeric,
  add column if not exists pending_qty                numeric,
  add column if not exists current_production_stage   text,
  add column if not exists total_delay_days           integer;
