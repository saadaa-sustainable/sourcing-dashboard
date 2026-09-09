-- Cutting register → GCP: mark which sd_cutting_register rows have been pushed to
-- the warehouse BigQuery table (saadaa-wh.MAPLEMONK.po_qty_cutting_register).
-- The batch reconcile pushes rows where bq_synced_at is null and stamps them on success;
-- the immediate on-save push stamps the single row it wrote. Nothing is ever un-stamped,
-- so a row is pushed at most once (insertId also dedups streaming retries).

alter table public.sd_cutting_register
  add column if not exists bq_synced_at timestamptz;

-- Partial index: the reconcile query only ever scans the not-yet-pushed rows.
create index if not exists sd_cutting_register_bq_unsynced_idx
  on public.sd_cutting_register (id)
  where bq_synced_at is null;
