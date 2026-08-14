-- Completed-PO vendor-recommendation source: PO headers pulled DIRECTLY from the
-- EasyEcom API (getPurchaseOrderDetails), ALL statuses, from 2025-01-01. Populated
-- by backfill/fetch-ee-po.mjs (upsert on po_id). Separate from the BigQuery-fed
-- sd_po_master_raw; EDD (not returned by this endpoint) is joined from that table.
create table if not exists public.sd_ee_po (
  po_id                   bigint primary key,
  po_number               text,
  po_ref_num              text,
  po_status_id            integer,
  po_status               text,
  po_created_date         timestamptz,
  po_updated_date         timestamptz,
  po_created_warehouse    text,
  po_created_location_key text,
  vendor_name             text,
  vendor_code             text,
  vendor_c_id             bigint,
  vendor_location_key     text,
  total_po_value          numeric,
  synced_at               timestamptz not null default now(),
  raw                     jsonb
);
create index if not exists sd_ee_po_vendor_idx on public.sd_ee_po (vendor_code);
create index if not exists sd_ee_po_status_idx on public.sd_ee_po (po_status_id);

alter table public.sd_ee_po enable row level security;
do $$
begin
  if not exists (select 1 from pg_policies where schemaname='public' and tablename='sd_ee_po' and policyname='saadaa read sd_ee_po') then
    create policy "saadaa read sd_ee_po" on public.sd_ee_po for select to authenticated using (public.sd_is_saadaa());
  end if;
end $$;
