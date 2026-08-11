-- =====================================================================
-- EasyCom "Complete GRN" webhook — capture-first landing tables.
--
-- EasyCom → Supabase Edge Function (easyecom-grn) → these tables.
-- Every raw payload is archived in sd_grn_webhook_log so the field
-- mapping can be finalised after seeing real data — nothing is ever lost.
--
-- NB: this is a SEPARATE, OWNED table — it is NOT the BigQuery mirror
-- sd_po_grn_mapping (which backfill/sync-extra.mjs full-refreshes with a
-- DELETE mark-and-sweep every ~5 min, and would wipe any webhook rows).
-- =====================================================================

-- 1. Raw capture — every call (even bad-auth) is logged here.
create table if not exists public.sd_grn_webhook_log (
  id           bigserial primary key,
  received_at  timestamptz not null default now(),
  event_type   text,
  auth_ok      boolean,
  item_count   integer,
  headers      jsonb,
  raw_body     jsonb,
  note         text
);
create index if not exists sd_grn_log_received_idx
  on public.sd_grn_webhook_log (received_at desc);

-- 2. Parsed live GRN, one row per received PO line (upsert on row_key).
--    Columns mirror the GRN subset of sd_po_grn_mapping so a later
--    sd_grn_value union is trivial. Field names are best-guess until the
--    real payload is seen; the whole item is kept in `raw` regardless.
create table if not exists public.sd_grn_event (
  row_key              text primary key,          -- po_detail_id|grn_id
  grn_id               bigint,
  po_detail_id         text,
  po_number            bigint,
  po_ref_num           text,
  sku                  text,
  size                 text,
  warehouse            text,
  vendor_code          text,
  vendor_name          text,
  grn_status           text,
  grn_created_date     date,
  grn_invoice_date     date,
  grn_invoice_number   text,
  grn_receive_quantity double precision,
  total_grn_value      double precision,
  received_at          timestamptz not null default now(),
  raw                  jsonb
);
create index if not exists sd_grn_event_grn_idx on public.sd_grn_event (grn_id);
create index if not exists sd_grn_event_po_idx  on public.sd_grn_event (po_number);

-- 3. RLS — read for any @saadaa.in. Writes come only from the Edge Function
--    (service role), which bypasses RLS.
alter table public.sd_grn_event       enable row level security;
alter table public.sd_grn_webhook_log enable row level security;
grant select on public.sd_grn_event, public.sd_grn_webhook_log to authenticated;
do $$ begin
  if not exists (select 1 from pg_policies where schemaname='public'
                 and tablename='sd_grn_event' and policyname='sd_grn_event_read') then
    execute 'create policy sd_grn_event_read on public.sd_grn_event
               for select to authenticated using (public.sd_is_saadaa())';
  end if;
  if not exists (select 1 from pg_policies where schemaname='public'
                 and tablename='sd_grn_webhook_log' and policyname='sd_grn_log_read') then
    execute 'create policy sd_grn_log_read on public.sd_grn_webhook_log
               for select to authenticated using (public.sd_is_saadaa())';
  end if;
end $$;

-- Verify after the first webhook fires:
--   select id, received_at, event_type, item_count, auth_ok, raw_body
--   from sd_grn_webhook_log order by received_at desc limit 1;
--   select * from sd_grn_event order by received_at desc limit 10;
