-- Landing table for the OOS Calculation tab (a faithful mirror of the DOQ/OOS sheet,
-- one row per SKU). Populated by backfill/backfill-oos.mjs from the fixed BigQuery
-- sources (saadaa_inventory_planning + saadaa_consolidated_product_master), 45-day window.
create table if not exists public.sd_oos_calculation (
  sku                   text primary key,
  product_status        text,
  category_with_gender  text,
  rm_code               text,
  dyed_fabric_sku       text,
  product_variant       text,
  product_code          text,
  product_name          text,
  color                 text,
  size                  text,
  new_size              text,
  total_inventory_days  integer,
  total_oos_days        integer,
  total_available_days  integer,
  total_qty_sold        numeric,
  doq_45                numeric,
  launch_date           date,
  product_class         text,
  current_stock         integer,
  doh                   numeric,
  sales_value           numeric,
  sales_leakage         numeric,
  inprocess_stock       integer,
  doh_with_inprocess    numeric,
  cancelled             integer,
  returned              integer,
  com_status            text,
  weave_type            text,
  unique_key            text,
  synced_at             timestamptz not null default now()
);

alter table public.sd_oos_calculation enable row level security;

drop policy if exists "saadaa read sd_oos_calculation" on public.sd_oos_calculation;
create policy "saadaa read sd_oos_calculation" on public.sd_oos_calculation
  for select to authenticated using (public.sd_is_saadaa());

grant select on public.sd_oos_calculation to authenticated;
