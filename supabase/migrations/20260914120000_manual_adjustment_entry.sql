-- Manual Adjustment (PO) entered ON the dashboard — replaces the external Apps Script
-- ingestion portal for this feed. This is the OWNED input table; each row is pushed BACK
-- into the warehouse BigQuery table saadaa-wh.MAPLEMONK.po_qty_manual_adjustment
-- (append-only, exactly like sd_cutting_register -> po_qty_cutting_register).
--
-- NOT to be confused with sd_po_qty_manual_adjustment, the read-only SNAPSHOT that the
-- BigQuery sync pulls back for the "Synced data" view (no PK, replaced on refresh).
--
-- Push idempotency mirrors the cutting register: a row is pushed only while
-- bq_synced_at IS NULL, stamped on success, never un-stamped; the streaming insertId
-- ("sd_manual_adjustment_entry:<id>") dedups retries.

create table if not exists public.sd_manual_adjustment_entry (
  id                 bigserial primary key,
  po_ref_num         text not null,          -- warehouse po_no (the PO reference, e.g. FY26-27/FOB/SMFFK/KVN-10)
  sku_code           text not null,          -- variant SKU on that PO (e.g. SMFFKRT_2XL)
  manual_adjust_qty  numeric not null,       -- signed correction in whole pieces
  po_type            text,                   -- FOB | JOB | EFOB, derived from the PO reference
  remarks            text,
  submitted_via      text not null default 'dashboard',
  submitted_by_email text,                   -- warehouse ingestion_by
  created_at         timestamptz not null default now(), -- warehouse ingestion_date
  bq_synced_at       timestamptz
);
create index if not exists sd_manual_adjustment_entry_po_idx
  on public.sd_manual_adjustment_entry (po_ref_num);
-- Partial index: the reconcile only ever scans the not-yet-pushed rows.
create index if not exists sd_manual_adjustment_entry_bq_unsynced_idx
  on public.sd_manual_adjustment_entry (id)
  where bq_synced_at is null;

alter table public.sd_manual_adjustment_entry enable row level security;

grant select, insert, update on public.sd_manual_adjustment_entry to authenticated;
grant usage, select on sequence public.sd_manual_adjustment_entry_id_seq to authenticated;

-- Everyone signed in at saadaa reads; writers (team/admin) enter adjustments.
drop policy if exists "saadaa read sd_manual_adjustment_entry" on public.sd_manual_adjustment_entry;
create policy "saadaa read sd_manual_adjustment_entry" on public.sd_manual_adjustment_entry
  for select using (sd_is_saadaa());

drop policy if exists "sourcing write sd_manual_adjustment_entry" on public.sd_manual_adjustment_entry;
create policy "sourcing write sd_manual_adjustment_entry" on public.sd_manual_adjustment_entry
  for all using (sd_can_write()) with check (sd_can_write());
