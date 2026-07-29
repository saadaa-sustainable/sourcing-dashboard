-- =====================================================================
-- Landing tables in the NPD-Tracker v7 Supabase (xntnqlrcxznximxbskut) for the
-- two BigQuery tables added to the ~5-min sync (backfill/sync-extra.mjs):
--   saadaa-wh.MAPLEMONK.saadaa_inventory_planning  (LATEST date_day snapshot)
--   saadaa-wh.MAPLEMONK.saadaa_po_grn_mapping       (full)
--
-- Column names are the BigQuery names lower-cased. Each row carries a computed
-- row_key (natural key) as the upsert target and a synced_at stamp; the sync
-- upserts the whole snapshot then deletes rows whose synced_at predates the run
-- (mark-and-sweep = a clean full refresh over PostgREST).
-- =====================================================================

create table if not exists public.sd_inventory_planning (
  row_key    text primary key,          -- sku|warehouse
  date_day   date,
  sku        text,
  warehouse  text,
  rm_code    text,
  dyed_fabric_sku text,
  product_name text,
  product_variant text,
  color      text,
  size       text,
  category   text,
  sub_category text,
  fabric_consumption_average double precision,
  categorytype text,
  cost       double precision,
  item_category text,
  gender     text,
  fittype    text,
  age_group  text,
  demographic_price_range text,
  weave_type text,
  fabric_name text,
  fabric_composition text,
  fabric_gsm text,
  garment_length_type text,
  sleeve_type text,
  neck_collar_type text,
  replenishment_type text,
  washcare_sku text,
  season     text,
  gst        text,
  related_ongoing_product text,
  qty_in_metres text,
  product_state text,
  daily_quantity double precision,
  has_inventory_today bigint,
  t7_quantity double precision,
  t730_quantity double precision,
  t73015_quantity double precision,
  t45_quantity double precision,
  doq_7 double precision,
  doq_15 double precision,
  doq_7_30 double precision,
  doq_30_45 double precision,
  doq_90 double precision,
  doq_30 double precision,
  doq_45 double precision,
  doq_365 double precision,
  oos_days_7 bigint,
  oos_days_15 bigint,
  oos_days_30 bigint,
  oos_days_45 bigint,
  oos_days_90 bigint,
  oos_days_365 bigint,
  total_sales_in_last_45_inventory_days double precision,
  weighted_doq_45 double precision,
  weightage_doq double precision,
  monthly_doq double precision,
  yearly_doq double precision,
  lead_time bigint,
  buffer_days bigint,
  current_stock bigint,
  total_inprogress bigint,
  shopify_sp double precision,
  v_doq double precision,
  synced_at  timestamptz not null default now()
);
create index if not exists sd_inv_plan_sku_idx on public.sd_inventory_planning (sku);
create index if not exists sd_inv_plan_variant_idx on public.sd_inventory_planning (product_variant);
create index if not exists sd_inv_plan_synced_idx on public.sd_inventory_planning (synced_at);

create table if not exists public.sd_po_grn_mapping (
  row_key    text primary key,          -- po_detail_id|grn_id
  po_created_date date,
  po_detail_id text,
  po_id      bigint,
  po_number  bigint,
  cp_id      text,
  sku        text,
  size       text,
  product_description text,
  po_created_warehouse text,
  po_created_location_key text,
  po_status  text,
  vendor_name text,
  vendor_code text,
  expected_delivery_date text,
  grn_id     bigint,
  po_ref_num text,
  grn_status text,
  grn_created_date date,
  grn_invoice_date date,
  grn_invoice_number text,
  last_grn_date date,
  po_type    text,
  po_original_quantity double precision,
  po_pending_quantity double precision,
  total_grn_value double precision,
  grn_receive_quantity double precision,
  synced_at  timestamptz not null default now()
);
create index if not exists sd_po_grn_detail_idx on public.sd_po_grn_mapping (po_detail_id);
create index if not exists sd_po_grn_po_idx on public.sd_po_grn_mapping (po_number);
create index if not exists sd_po_grn_synced_idx on public.sd_po_grn_mapping (synced_at);

-- Read for signed-in users; writes come only from the sync (service role, bypasses RLS).
alter table public.sd_inventory_planning enable row level security;
alter table public.sd_po_grn_mapping     enable row level security;
grant select on public.sd_inventory_planning, public.sd_po_grn_mapping to authenticated;
do $$ begin
  if not exists (select 1 from pg_policies where schemaname='public'
                 and tablename='sd_inventory_planning' and policyname='sd_inv_plan_read') then
    execute 'create policy sd_inv_plan_read on public.sd_inventory_planning
               for select to authenticated using (true)';
  end if;
  if not exists (select 1 from pg_policies where schemaname='public'
                 and tablename='sd_po_grn_mapping' and policyname='sd_po_grn_read') then
    execute 'create policy sd_po_grn_read on public.sd_po_grn_mapping
               for select to authenticated using (true)';
  end if;
end $$;
