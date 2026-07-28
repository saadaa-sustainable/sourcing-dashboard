-- =====================================================================
-- EasyCom Inventory webhook — capture-first landing tables.
--
-- EasyCom → Supabase Edge Function (easyecom-inventory) → these tables.
-- Every raw payload is archived in sd_inventory_webhook_log so the field
-- mapping can be finalised after seeing real data — nothing is ever lost.
-- =====================================================================

-- 1. Raw capture — every call (even bad-auth) is logged here.
create table if not exists public.sd_inventory_webhook_log (
  id           bigserial primary key,
  received_at  timestamptz not null default now(),
  trigger_type text,
  marketplace  text,
  item_count   integer,
  auth_ok      boolean,
  headers      jsonb,
  raw_body     jsonb,
  note         text
);
create index if not exists sd_inv_log_received_idx
  on public.sd_inventory_webhook_log (received_at desc);

-- 2. Current stock per SKU per warehouse (upsert on sku + warehouse).
--    Column names are best-guess until the real payload is seen; the whole
--    item is also kept in `raw`, so nothing is lost if a name differs.
create table if not exists public.sd_inventory (
  sku                text not null,
  warehouse          text not null default '',
  product_id         text,
  available_quantity numeric,
  total_quantity     numeric,
  reserved_quantity  numeric,
  received_at        timestamptz not null default now(),
  raw                jsonb,
  primary key (sku, warehouse)
);
create index if not exists sd_inventory_sku_idx on public.sd_inventory (sku);

-- 3. Inventory joined to product_code + variant, derived from the SKU with the
--    same convention as the PO pipeline: <product_code><2-char colour>_<size>.
create or replace view public.sd_inventory_enriched as
select
  i.*,
  regexp_replace(i.sku, '_[^_]+$', '') as product_variant,
  case
    when length(regexp_replace(i.sku, '_[^_]+$', '')) > 2
      then left(regexp_replace(i.sku, '_[^_]+$', ''),
                length(regexp_replace(i.sku, '_[^_]+$', '')) - 2)
    else regexp_replace(i.sku, '_[^_]+$', '')
  end as product_code,
  substring(i.sku from '_([^_]+)$') as size
from public.sd_inventory i;

-- 4. RLS — read for any @saadaa.in. Writes come only from the Edge Function
--    (service role), which bypasses RLS.
alter table public.sd_inventory             enable row level security;
alter table public.sd_inventory_webhook_log enable row level security;
grant select on public.sd_inventory, public.sd_inventory_webhook_log,
                public.sd_inventory_enriched to authenticated;
do $$ begin
  -- If sd_is_saadaa() isn't present yet, replace `using (public.sd_is_saadaa())`
  -- with `using (true)` and tighten later.
  if not exists (select 1 from pg_policies where schemaname='public'
                 and tablename='sd_inventory' and policyname='sd_inventory_read') then
    execute 'create policy sd_inventory_read on public.sd_inventory
               for select to authenticated using (public.sd_is_saadaa())';
  end if;
  if not exists (select 1 from pg_policies where schemaname='public'
                 and tablename='sd_inventory_webhook_log' and policyname='sd_inventory_log_read') then
    execute 'create policy sd_inventory_log_read on public.sd_inventory_webhook_log
               for select to authenticated using (public.sd_is_saadaa())';
  end if;
end $$;

-- Verify after the first webhook fires:
--   select id, received_at, trigger_type, item_count, auth_ok, raw_body
--   from sd_inventory_webhook_log order by received_at desc limit 1;
--   select * from sd_inventory order by received_at desc limit 10;
