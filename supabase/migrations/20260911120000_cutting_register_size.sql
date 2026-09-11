-- Cutting is recorded per size: add a size column to the dashboard cutting register.
-- (Whether it also reaches the warehouse po_qty_cutting_register depends on that table
--  having a `size` column — the BigQuery push only sends columns that exist there.)
alter table public.sd_cutting_register
  add column if not exists size text;
