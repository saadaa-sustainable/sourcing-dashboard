-- New (not-in-EasyEcom) products enter Standard Cost ONLY from NPD Tracker V7 (user, 2026-10-09).
--
-- Before: anyone could type a name and get a system TMP-xxxx code, with no record of where the
-- product came from. Now the product is picked from NPD Tracker V7 (its own Supabase project) and
-- carries the NPD SKU code as its product code. The NPD row it came from is kept on the
-- temporary-product registry, so every new product has a record.
--
-- The registry stays sd_temp_product (the whole app — badges, link / merge into the EasyEcom
-- code, delete — reads that table, not a "TMP-" prefix). Older TMP rows keep source 'manual'.

alter table public.sd_temp_product
  add column if not exists source           text not null default 'manual',
  add column if not exists npd_product_id   bigint,
  add column if not exists npd_item_code    text,
  add column if not exists npd_sku_code     text,
  add column if not exists npd_category     text,
  add column if not exists npd_status       text,
  add column if not exists npd_product_type text;

do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'sd_temp_product_source_check') then
    alter table public.sd_temp_product
      add constraint sd_temp_product_source_check check (source in ('manual', 'npd'));
  end if;
end $$;

-- One NPD row → at most one live product.
create unique index if not exists sd_temp_product_npd_live_uniq
  on public.sd_temp_product (npd_product_id)
  where npd_product_id is not null and status = 'active';

-- Register an NPD Tracker V7 product under its SKU code + seed nothing else (the caller seeds the
-- Standard Cost row). Refuses a code that is malformed, already registered, already on Standard
-- Cost, or already an EasyEcom product (that one is added "From Product Master" instead).
create or replace function public.sd_register_npd_product(
  p_code      text,
  p_name      text,
  p_npd_id    bigint,
  p_item_code text,
  p_category  text,
  p_status    text,
  p_type      text,
  p_by        text
)
returns text
language plpgsql
security definer
set search_path = public
as $$
declare v_code text := upper(btrim(coalesce(p_code, '')));
begin
  if not public.sd_can_write() then
    raise exception 'You do not have permission to add products.';
  end if;
  if v_code !~ '^[A-Z0-9]{3,30}$' then
    raise exception 'NPD SKU code "%" is not a single product code. Fix it in NPD Tracker V7 first.', coalesce(p_code, '');
  end if;
  if p_npd_id is null then
    raise exception 'The NPD product is missing its id.';
  end if;
  if exists (select 1 from public.sd_temp_product where npd_product_id = p_npd_id and status = 'active') then
    raise exception 'This NPD product is already on Standard Cost.';
  end if;
  if exists (select 1 from public.sd_temp_product where upper(temp_code) = v_code) then
    raise exception '% is already registered as a product not in EasyEcom.', v_code;
  end if;
  if exists (select 1 from public.sd_standard_cost where upper(product_code) = v_code) then
    raise exception '% is already on Standard Cost.', v_code;
  end if;
  if exists (select 1 from public.sd_product_catalog where upper(product_code) = v_code) then
    raise exception '% already exists in EasyEcom. Add it "From Product Master" instead.', v_code;
  end if;

  insert into public.sd_temp_product
    (temp_code, name, created_by, source, npd_product_id, npd_item_code, npd_sku_code, npd_category, npd_status, npd_product_type)
  values
    (v_code, nullif(btrim(p_name), ''), p_by, 'npd', p_npd_id, nullif(btrim(p_item_code), ''), v_code,
     nullif(btrim(p_category), ''), nullif(btrim(p_status), ''), nullif(btrim(p_type), ''));
  return v_code;
end;
$$;

revoke all on function public.sd_register_npd_product(text, text, bigint, text, text, text, text, text) from public, anon;
grant execute on function public.sd_register_npd_product(text, text, bigint, text, text, text, text, text) to authenticated;
