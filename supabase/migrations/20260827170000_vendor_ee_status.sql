-- EasyEcom's own vendor active/inactive status, pulled through GCP by
-- BqSync.gs -> vendors(). This is DISTINCT from is_active, which is the sync
-- mark-and-sweep housekeeping flag ("row still present in the source"), not a
-- business status. The raw source value is stored as text; the app decodes it
-- to active/inactive (see eeVendorActive in src/lib/business-logic.ts).
alter table public.vendor_master_data
  add column if not exists ee_status text;

comment on column public.vendor_master_data.ee_status is
  'Raw vendor status from EasyEcom (Easyecom_Saadaa_vendors, via BqSync GCP sync). Decoded to active/inactive in the app; NULL until the first GCP vendor sync runs. Not to be confused with is_active (sync housekeeping flag).';

-- Existing "grant select ... to authenticated" already covers new columns, so no
-- policy change is needed. Refresh PostgREST's schema cache so the column is
-- immediately visible to the API (reads use select('*'); the sync writes it by name).
notify pgrst, 'reload schema';
