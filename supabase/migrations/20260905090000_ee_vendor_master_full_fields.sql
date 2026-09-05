-- =====================================================================
-- sd_ee_vendor_master — capture EVERY EasyEcom vendor field.
--
-- Airbyte's normalized `Easyecom_Saadaa_vendors` table kept only 9 of the ~26
-- fields EasyEcom returns; the rest (contact person, phone, PAN, GSTIN, MSME,
-- DL, FSSAI, prep/transit days, tokens) live only in the raw _airbyte_data JSON.
-- Add columns for all of them so the sync (rewritten to read the raw JSON) can
-- land the complete vendor record. All text, as EasyEcom holds them.
-- =====================================================================

alter table public.sd_ee_vendor_master
  add column if not exists firstname                 text,
  add column if not exists lastname                  text,
  add column if not exists contact_number            text,
  add column if not exists pan                        text,
  add column if not exists tax_identification_number text,  -- GSTIN
  add column if not exists msme_number               text,
  add column if not exists unregistered_vendor       text,  -- "1"/"0"
  add column if not exists vendor_token              text,
  add column if not exists api_token                 text,
  add column if not exists dl_number                 text,
  add column if not exists dl_expiry                 text,
  add column if not exists fssai_number              text,
  add column if not exists fssai_expiry              text,
  add column if not exists freight_forwarding_days   text,
  add column if not exists prep_days                 text,
  add column if not exists shipment_intransit_days   text,
  add column if not exists warehouse_checkin_time    text;
