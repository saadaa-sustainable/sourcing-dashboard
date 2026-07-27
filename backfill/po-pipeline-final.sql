-- =====================================================================
-- PO PIPELINE — EE_purchase_orders (BigQuery, saadaa-wh) -> Supabase
--
-- Landing table (one row per PO line) + read views for the dashboard.
-- The app NEVER queries BigQuery at runtime — it reads these Supabase views.
-- backfill-po.mjs loads the table; later an EasyCom webhook keeps it live.
--
-- Source (validated against live data, asia-south1):
--   saadaa-wh.MAPLEMONK.EE_purchase_orders            (header, ~12k POs)
--   saadaa-wh.MAPLEMONK.EE_purchase_orders_po_items   (64,016 lines)
--   joined on _airbyte_EE_purchase_orders_hashid
--
-- Status codes (confirmed from the data, line counts match exactly):
--   2 Waiting (13)      -> exclude (not placed)
--   3 Approved (25775)  -> IN PROCESS (being fulfilled, pending remains)
--   4 Rejected (2514)   -> exclude
--   5 Completed (32358) -> COMPLETED
--   7 cancelled (3356)  -> exclude
-- =====================================================================

create table if not exists public.sd_po_master_raw (
  po_detail_id           text primary key,      -- purchase_order_detail_id (per line)
  po_id                  text,
  po_number              text,
  po_ref_num             text,
  po_status_code         integer,               -- 2/3/4/5/7
  po_status              text,                  -- Waiting/Approved/Rejected/Completed/cancelled
  vendor_code            text,
  vendor_name            text,
  warehouse              text,
  sku                    text,                  -- e.g. SDRPTBR_XS
  product_id             text,
  product_code           text,                  -- derived: SDRPT
  product_variant        text,                  -- derived: SDRPTBR
  size                   text,                  -- derived: XS
  product_description    text,
  original_qty           numeric,
  pending_qty            numeric,
  item_price             numeric,
  total_po_value         numeric,
  po_date                date,
  po_updated_date        date,
  expected_delivery_date date,
  ingested_at            timestamptz not null default now()
);
create index if not exists sd_po_raw_status_idx  on public.sd_po_master_raw (po_status_code);
create index if not exists sd_po_raw_vendor_idx  on public.sd_po_master_raw (vendor_code);
create index if not exists sd_po_raw_product_idx on public.sd_po_master_raw (product_code);
create index if not exists sd_po_raw_ponum_idx   on public.sd_po_master_raw (po_number);

-- RLS: read for any @saadaa.in. Writes come only from the backfill/webhook
-- (service_role), which bypasses RLS.
alter table public.sd_po_master_raw enable row level security;
grant select on public.sd_po_master_raw to authenticated;
do $$ begin
  if not exists (
    select 1 from pg_policies
    where schemaname='public' and tablename='sd_po_master_raw' and policyname='sd_po_read'
  ) then
    -- If sd_is_saadaa() doesn't exist yet, swap the USING clause for using (true).
    execute 'create policy sd_po_read on public.sd_po_master_raw
               for select to authenticated using (public.sd_is_saadaa())';
  end if;
end $$;

-- ---------------------------------------------------------------------
-- 1. In process = Approved (3) — still being fulfilled.
-- 2. Completed = Completed (5).
-- ---------------------------------------------------------------------
create or replace view public.sd_po_in_process as
  select * from public.sd_po_master_raw where po_status_code = 3;

create or replace view public.sd_po_completed as
  select * from public.sd_po_master_raw where po_status_code = 5;

-- ---------------------------------------------------------------------
-- 3. Vendor in-process rollup — feeds Vendor Capacity available-capacity.
--    in_process_qty = what is still to arrive from open (Approved) POs.
-- ---------------------------------------------------------------------
create or replace view public.sd_vendor_in_process as
  select
    vendor_code,
    max(vendor_name)      as vendor_name,
    count(distinct po_id) as open_po_count,
    sum(pending_qty)      as in_process_qty,
    sum(original_qty)     as ordered_qty
  from public.sd_po_in_process
  group by vendor_code;

-- ---------------------------------------------------------------------
-- 4. Buying-plan actuals — issued qty/value by product by month.
--    "Issued" = actually placed = Approved + Completed (3,5).
--    Excludes Waiting/Rejected/cancelled. Joined live in the app.
-- ---------------------------------------------------------------------
create or replace view public.sd_po_actuals_by_product_month as
  select
    product_code,
    date_trunc('month', po_date)::date as plan_month,
    sum(original_qty)                  as issued_qty,
    sum(original_qty * item_price)     as issued_value,
    count(distinct po_id)              as po_count
  from public.sd_po_master_raw
  where po_date is not null
    and po_status_code in (3, 5)
  group by product_code, date_trunc('month', po_date);

-- ---------------------------------------------------------------------
-- 5. Enriched lines — product_code + variant on every PO line.
--    For the Inward Plan: group by (po_number, product_code, product_variant).
-- ---------------------------------------------------------------------
create or replace view public.sd_po_lines_enriched as
  select
    po_detail_id, po_number, po_ref_num, po_status, po_status_code,
    vendor_code, vendor_name,
    product_code, product_variant, size, sku, product_description,
    original_qty, pending_qty, item_price,
    po_date, expected_delivery_date
  from public.sd_po_master_raw;

grant select on
  public.sd_po_in_process, public.sd_po_completed,
  public.sd_vendor_in_process, public.sd_po_actuals_by_product_month,
  public.sd_po_lines_enriched
  to authenticated;

-- Verify after backfill:
--   select count(*) from sd_po_master_raw;                       -- ~64k
--   select po_status, count(*) from sd_po_master_raw group by 1; -- matches BigQuery
--   select * from sd_vendor_in_process order by in_process_qty desc limit 10;
