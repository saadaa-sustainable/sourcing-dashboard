-- NPD products enter Standard Cost under their NPD ITEM CODE (user, 2026-10-09), not the SKU code.
-- The SKU code is kept on the registry (npd_sku_code, as written on NPD Tracker V7) for PO Approval,
-- where SKU quantities are added. Item codes are stored upper-cased (K-WBW-SC-011-V1) because the
-- dashboard upper-cases product codes in links and lookups. No product had been added through the
-- previous SKU-code version (checked: 0 rows with source = 'npd').

drop function if exists public.sd_register_npd_product(text, text, bigint, text, text, text, text, text);

create or replace function public.sd_register_npd_product(
  p_item_code text,
  p_sku_code  text,
  p_name      text,
  p_npd_id    bigint,
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
declare v_code text := upper(btrim(coalesce(p_item_code, '')));
begin
  if not public.sd_can_write() then
    raise exception 'You do not have permission to add products.';
  end if;
  if v_code !~ '^[A-Z0-9][A-Z0-9-]{2,39}$' then
    raise exception 'NPD item code "%" is missing or not a single code. Fix it in NPD Tracker V7 first.', coalesce(p_item_code, '');
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
    (v_code, nullif(btrim(p_name), ''), p_by, 'npd', p_npd_id, v_code, nullif(btrim(p_sku_code), ''),
     nullif(btrim(p_category), ''), nullif(btrim(p_status), ''), nullif(btrim(p_type), ''));
  return v_code;
end;
$$;

revoke all on function public.sd_register_npd_product(text, text, text, bigint, text, text, text, text) from public, anon;
grant execute on function public.sd_register_npd_product(text, text, text, bigint, text, text, text, text) to authenticated;
