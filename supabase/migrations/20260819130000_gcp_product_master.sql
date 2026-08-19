-- GCP product master (from saadaa-wh.MAPLEMONK.saadaa_consolidated_product_master),
-- SKU-level. Shown read-only on the Product Master tab; loaded by sync-daily.mjs.
create table if not exists public.sd_gcp_product_master (
  sku                 text primary key,
  product_code        text,
  product_name        text,
  product_variant     text,
  size                text,
  color               text,
  category            text,
  gender              text,
  item_category       text,
  sub_category        text,
  product_state       text,
  weave_type          text,
  rm_code             text,
  dyed_fabric_sku     text,
  launch_date         text,
  mrp                 numeric,
  cost                numeric,
  fabric_name         text,
  fabric_gsm          text,
  fit_type            text,
  age_group           text,
  season              text,
  replenishment_type  text,
  product_type        text,
  synced_at           timestamptz not null default now()
);
create index if not exists sd_gcp_product_master_code_idx on public.sd_gcp_product_master (product_code);

alter table public.sd_gcp_product_master enable row level security;
drop policy if exists "saadaa read sd_gcp_product_master" on public.sd_gcp_product_master;
create policy "saadaa read sd_gcp_product_master" on public.sd_gcp_product_master
  for select to authenticated using (public.sd_is_saadaa());
grant select on public.sd_gcp_product_master to authenticated;

-- Roll GCP SKU-level status/weave up to the product-code families by matching each SKU
-- to the LONGEST known product code that prefixes it (SDCSSBLS -> SDCSS, not SDCS). The
-- code universe lives in sd_product_master (GCP has no clean product-code column). Values
-- are normalised so the Buying Plan's 'Discontinued' filter + Woven/Knitted keep working.
create or replace view public.sd_gcp_product_code_status
with (security_invoker = true) as
with codes as (
  select distinct product_code from public.sd_product_master
  where product_code is not null and btrim(product_code) <> ''
),
matched as (
  select
    (select c.product_code from codes c
      where g.sku like c.product_code || '%'
      order by length(c.product_code) desc
      limit 1) as product_code,
    case
      when upper(g.product_state) like '%DISCONTINUE%'                                       then 'Discontinued'
      when upper(g.product_state) like '%NPD%' or upper(g.product_state) like '%NOT LAUNCH%' then 'NPD-Not-Launched'
      when upper(g.product_state) like '%ONGOING%'                                            then 'Ongoing'
      when g.product_state is null or btrim(g.product_state) = ''                             then null
      else initcap(g.product_state)
    end as norm_status,
    case
      when upper(g.weave_type) in ('KNIT', 'KNITTED', 'TERRY')                                then 'Knitted'
      when upper(g.weave_type) like '%WOVEN%' or upper(g.weave_type) like '%TWILL%'           then 'Woven'
      else null
    end as norm_weave
  from public.sd_gcp_product_master g
)
select
  product_code,
  mode() within group (order by norm_status) filter (where norm_status is not null) as product_status,
  mode() within group (order by norm_weave)  filter (where norm_weave  is not null) as fabric_type
from matched
where product_code is not null
group by product_code;

grant select on public.sd_gcp_product_code_status to authenticated;
