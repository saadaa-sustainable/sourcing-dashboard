-- =====================================================================
-- EasyEcom Item/Product Master landing table + a purpose-built DOQ view.
--
--   BigQuery saadaa-wh.MAPLEMONK.EasyEcom_SAADAA_product_master
--        -> public.sd_ee_product_master   (full refresh, keyed on sku)
--
--   public.sd_doq  = thin view over the already-synced sd_inventory_planning,
--                    exposing only SKU + 45-day / 365-day DOQ and the
--                    in-process figures (v_doq, total_inprogress) so the
--                    real "IP DOQ" column can be pinned later.
--
-- NOTE: this is the EasyEcom master; it is deliberately separate from the
-- manual Woven/Knitted master public.sd_product_master (do not conflate).
-- All source columns are STRING in BigQuery, so they land as text here.
-- =====================================================================

create table if not exists public.sd_ee_product_master (
  sku                   text primary key,
  mrp                   text,
  c_id                  text,
  cost                  text,
  size                  text,
  brand                 text,
  cp_id                 text,
  width                 text,
  active                text,
  colour                text,
  height                text,
  length                text,
  weight                text,
  brand_id              text,
  hsn_code              text,
  model_no              text,
  tax_rate              text,
  inventory             text,
  created_at            text,
  product_id            text,
  updated_at            text,
  category_id           text,
  description           text,
  expiry_type           text,
  company_name          text,
  cp_inventory          text,
  product_name          text,
  product_type          text,
  category_name         text,
  accounting_sku        text,
  accounting_unit       text,
  product_image_url     text,
  product_shelf_life    text,
  cp_sub_products_count text,
  synced_at             timestamptz not null default now()
);

create index if not exists sd_ee_pm_synced_idx on public.sd_ee_product_master (synced_at);

alter table public.sd_ee_product_master enable row level security;
grant select on public.sd_ee_product_master to authenticated;
do $$ begin
  if not exists (select 1 from pg_policies where schemaname='public'
                 and tablename='sd_ee_product_master' and policyname='sd_ee_pm_read') then
    execute 'create policy sd_ee_pm_read on public.sd_ee_product_master
             for select to authenticated using (true)';
  end if;
end $$;

-- DOQ view: SKU, 45-day DOQ, 365-day DOQ + in-process figures.
create or replace view public.sd_doq as
select
  sku,
  warehouse,
  product_name,
  doq_45           as doq_45,
  doq_365          as doq_365,
  v_doq            as v_doq,
  total_inprogress as total_inprogress,
  current_stock,
  synced_at
from public.sd_inventory_planning;

grant select on public.sd_doq to authenticated;
