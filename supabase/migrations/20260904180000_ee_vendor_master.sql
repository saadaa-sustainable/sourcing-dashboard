-- EasyEcom vendor master — RAW landing, exactly as EasyEcom/BigQuery
-- (saadaa-wh.MAPLEMONK.Easyecom_Saadaa_vendors) holds it. No transformation, no added
-- business columns: a column-for-column mirror (address stays the raw JSON string it is
-- in the source) plus synced_at for freshness. Kept SEPARATE from the hybrid
-- vendor_master_data (which keeps the Google-Sheet-owned capacity model + the app's
-- vendor_code key) — this table is the untouched source copy the senior asked for.
-- BqSync.eeVendorMaster() full-refreshes it (delete + insert) each run, so it always
-- equals the source. Columns match runQuery()'s lowercased field names.
create table if not exists public.sd_ee_vendor_master (
  id                                       bigint generated always as identity primary key,
  email                                    text,
  active                                   text,   -- '1' / '0' as EasyEcom stores it
  address                                  text,   -- raw JSON string, kept verbatim
  paymentterm                              text,
  vendor_c_id                              text,   -- EasyEcom internal vendor id
  vendor_code                              text,
  vendor_name                              text,
  deliveryterm                             text,
  currency_code                            text,
  _airbyte_ab_id                           text,
  _airbyte_emitted_at                      timestamptz,
  _airbyte_normalized_at                   timestamptz,
  _airbyte_easyecom_saadaa_vendors_hashid  text,
  synced_at                                timestamptz not null default now()
);

create index if not exists sd_ee_vendor_master_code_idx on public.sd_ee_vendor_master (vendor_code);

alter table public.sd_ee_vendor_master enable row level security;

-- Read for SAADAA staff; writes come from BqSync via the service role (bypasses RLS).
drop policy if exists sd_ee_vendor_master_read on public.sd_ee_vendor_master;
create policy sd_ee_vendor_master_read on public.sd_ee_vendor_master
  for select using (public.sd_is_saadaa());
