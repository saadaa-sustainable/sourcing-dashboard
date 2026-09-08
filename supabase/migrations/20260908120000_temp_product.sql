-- Temporary product IDs. A product not yet in EasyEcom/Product Master can be created
-- in Standard Cost with a system-minted unique code (TMP-0007) + a readable name. The
-- temp code is used as product_code everywhere (Standard Cost, Buying Plan, PO). When
-- the real product later appears in EasyEcom, an admin MERGES the temp into the real
-- code — atomically repointing every owned table that stores a product_code.

create table if not exists public.sd_temp_product (
  temp_code    text primary key,          -- e.g. TMP-0007 (also the product_code used everywhere)
  name         text,                      -- readable name the creator typed
  status       text not null default 'active' check (status in ('active', 'merged')),
  merged_into  text,                      -- the real EasyEcom code, once merged
  merged_at    timestamptz,
  merged_by    text,
  created_by   text,
  created_at   timestamptz not null default now()
);
create index if not exists sd_temp_product_status_idx on public.sd_temp_product (status, created_at desc);

alter table public.sd_temp_product enable row level security;
drop policy if exists sd_temp_product_read on public.sd_temp_product;
create policy sd_temp_product_read on public.sd_temp_product for select using (public.sd_is_saadaa());
drop policy if exists sd_temp_product_write on public.sd_temp_product;
create policy sd_temp_product_write on public.sd_temp_product for all using (public.sd_can_write()) with check (public.sd_can_write());

create sequence if not exists public.sd_temp_product_seq;

-- Mint a unique temp code + register it (atomic via the sequence).
create or replace function public.sd_mint_temp_product(p_name text, p_by text)
returns text
language plpgsql
security definer
set search_path = public
as $$
declare v_code text;
begin
  v_code := 'TMP-' || lpad(nextval('public.sd_temp_product_seq')::text, 4, '0');
  insert into public.sd_temp_product (temp_code, name, created_by)
  values (v_code, nullif(btrim(p_name), ''), p_by);
  return v_code;
end;
$$;

-- Merge a temp product into its real EasyEcom code. Atomic: any unique-constraint
-- collision (or a real code that already has a Standard Cost) raises and rolls the
-- whole thing back — block-and-resolve, nothing half-repointed.
create or replace function public.sd_merge_temp_product(p_temp text, p_real text, p_by text)
returns text
language plpgsql
security definer
set search_path = public
as $$
begin
  if p_temp is null or p_real is null or btrim(p_real) = '' then
    raise exception 'Both the temp code and the real product code are required.';
  end if;
  p_real := btrim(p_real);
  if not exists (select 1 from public.sd_temp_product where temp_code = p_temp and status = 'active') then
    raise exception 'No active temporary product %.', p_temp;
  end if;
  if exists (select 1 from public.sd_standard_cost where product_code = p_real) then
    raise exception 'Product % already has a Standard Cost — resolve that manually before merging.', p_real;
  end if;

  -- Repoint every OWNED table that stores a product_code (mirror/computed tables are
  -- excluded: a temp code never appears in them). po_ref_num strings are left as-is.
  update public.sd_standard_cost                     set product_code = p_real where product_code = p_temp;
  update public.sd_standard_cost_line                set product_code = p_real where product_code = p_temp;
  update public.sd_standard_cost_rate_history        set product_code = p_real where product_code = p_temp;
  update public.sd_cmtp_component                    set product_code = p_real where product_code = p_temp;
  update public.sd_cmtp_revision                     set product_code = p_real where product_code = p_temp;
  update public.sd_buying_plan_line                  set product_code = p_real where product_code = p_temp;
  update public.sd_po_approval                       set product_code = p_real where product_code = p_temp;
  update public.sd_discontinue_request              set product_code = p_real where product_code = p_temp;
  update public.sd_inward_plan_entry                 set product_code = p_real where product_code = p_temp;
  update public.sd_cutting_register                  set product_code = p_real where product_code = p_temp;
  update public.sd_vendor_product_capacity_allocation set product_code = p_real where product_code = p_temp;
  update public.sd_product_master                    set product_code = p_real where product_code = p_temp;

  update public.sd_temp_product
     set status = 'merged', merged_into = p_real, merged_at = now(), merged_by = p_by
   where temp_code = p_temp;
  return p_real;
end;
$$;

grant execute on function public.sd_mint_temp_product(text, text) to authenticated;
grant execute on function public.sd_merge_temp_product(text, text, text) to authenticated;

-- Rules-Master toggle: restrict Buying Plan + PO Approval to products that exist in
-- Standard Cost (real or temp). Default ON.
insert into public.sd_analytics_rule (rule_key, value, label, description) values
  ('restrict_plan_po_to_standard_cost', 1, 'Restrict Buying Plan / PO to Standard-Cost products',
   'When 1, Buying Plan and PO Approval only allow products that already exist in the Standard Cost sheet (real or temporary). 0 = allow any product.')
on conflict (rule_key) do nothing;
