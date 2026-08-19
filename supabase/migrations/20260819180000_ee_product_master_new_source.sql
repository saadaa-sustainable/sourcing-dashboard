-- Repoint sd_ee_product_master to Easyecom_new_product_master + its custom fields
-- (was EasyEcom_SAADAA_product_master). New column set: the 19 requested base fields
-- plus the 27 EasyEcom custom-field attributes (pivoted from
-- Easyecom_new_product_master_custom_fields on cp_id). All text; sku PK.
-- Load query lives in backfill/product-master-query.mjs.
drop table if exists public.sd_ee_product_master cascade;

create table public.sd_ee_product_master (
  sku                        text primary key,
  mrp                        text,
  cost                       text,
  size                       text,
  width                      text,
  active                     text,
  colour                     text,
  height                     text,
  length                     text,
  weight                     text,
  hsn_code                   text,
  model_no                   text,
  tax_rate                   text,
  created_at                 text,
  description                text,
  product_name               text,
  category_name              text,
  tax_rule_name              text,
  product_image_url          text,
  category_type              text,
  color_family               text,
  demographic_price_rage     text,
  dyed_fabric_sku            text,
  fabric_composition         text,
  fabric_gsm                 text,
  fabric_name                text,
  fabric_consumption_average text,
  fit_type                   text,
  gst                        text,
  garment_length_type        text,
  gender                     text,
  item_category              text,
  neck_collar_type           text,
  product_launch_date        text,
  product_state              text,
  product_type               text,
  product_variant            text,
  qty_in_meters              text,
  rm_fabric_sku              text,
  related_ongoing_product    text,
  replenishment_type         text,
  sub_category               text,
  season                     text,
  sleeve_type                text,
  weave_type                 text,
  washcare_sku               text,
  synced_at                  timestamptz not null default now()
);

create index sd_ee_pm_synced_idx on public.sd_ee_product_master (synced_at);

alter table public.sd_ee_product_master enable row level security;
grant select on public.sd_ee_product_master to authenticated;
create policy sd_ee_pm_read on public.sd_ee_product_master
  for select to authenticated using (true);
