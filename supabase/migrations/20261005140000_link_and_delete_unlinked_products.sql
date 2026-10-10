-- Standard Cost products that are not in EasyEcom (typed names like "ABCD", temporary TMP-xxxx
-- codes): link one to its EasyEcom product, or delete it.
--
-- sd_link_product generalises sd_merge_temp_product to ANY code that is not in the product
-- catalog, re-points every authored table that carries product_code (the old merge missed
-- sd_standard_cost_extra_fabric and sd_po_delete_request), and keeps a record of the link in
-- sd_temp_product (status merged, merged_into). Synced tables (pending_po_master,
-- sd_po_master_raw, po_details_form, sd_oos_calculation) belong to EasyEcom and are untouched.
--
-- Both check the caller's role here, not only in the app: they are SECURITY DEFINER, so
-- without the check any signed-in account could call them straight through the API.

create or replace function public.sd_link_product(p_from text, p_to text, p_by text)
returns text
language plpgsql
security definer
set search_path = public
as $$
begin
  if (select public.sd_current_role()) <> 'admin' then
    raise exception 'Only an admin can link a product to EasyEcom.';
  end if;
  p_from := btrim(coalesce(p_from, ''));
  p_to := upper(btrim(coalesce(p_to, '')));
  if p_from = '' or p_to = '' then
    raise exception 'Both the product and the EasyEcom product code are required.';
  end if;
  if upper(p_from) = p_to then
    raise exception 'That is the same code.';
  end if;
  if exists (select 1 from public.sd_product_catalog_mv where upper(product_code) = upper(p_from)) then
    raise exception '% is already an EasyEcom product — only products not in EasyEcom can be linked.', p_from;
  end if;
  if not exists (select 1 from public.sd_product_catalog_mv where upper(product_code) = p_to) then
    raise exception '% is not in the product master. Pick a product that exists in EasyEcom.', p_to;
  end if;
  if exists (select 1 from public.sd_standard_cost where upper(product_code) = p_to) then
    raise exception '% already has its own Standard Cost. Delete one of the two first, then link.', p_to;
  end if;

  update public.sd_standard_cost                      set product_code = p_to where product_code = p_from;
  update public.sd_standard_cost_line                 set product_code = p_to where product_code = p_from;
  update public.sd_standard_cost_extra_fabric         set product_code = p_to where product_code = p_from;
  update public.sd_standard_cost_rate_history         set product_code = p_to where product_code = p_from;
  update public.sd_cmtp_component                     set product_code = p_to where product_code = p_from;
  update public.sd_cmtp_revision                      set product_code = p_to where product_code = p_from;
  update public.sd_buying_plan_line                   set product_code = p_to where product_code = p_from;
  update public.sd_po_approval                        set product_code = p_to where product_code = p_from;
  update public.sd_po_delete_request                  set product_code = p_to where product_code = p_from;
  update public.sd_discontinue_request                set product_code = p_to where product_code = p_from;
  update public.sd_inward_plan_entry                  set product_code = p_to where product_code = p_from;
  update public.sd_cutting_register                   set product_code = p_to where product_code = p_from;
  update public.sd_vendor_product_capacity_allocation set product_code = p_to where product_code = p_from;
  update public.sd_product_master                     set product_code = p_to where product_code = p_from;

  -- Keep the link on record: a temporary product is marked merged; a typed code gets a row
  -- saying what it became, so old exports and the audit trail still read.
  insert into public.sd_temp_product as t (temp_code, name, status, merged_into, merged_at, merged_by, created_by)
  values (p_from, p_from, 'merged', p_to, now(), p_by, p_by)
  on conflict (temp_code) do update
    set status = 'merged', merged_into = excluded.merged_into, merged_at = excluded.merged_at, merged_by = excluded.merged_by;

  return p_to;
end;
$$;
revoke all on function public.sd_link_product(text, text, text) from public, anon;
grant execute on function public.sd_link_product(text, text, text) to authenticated;

-- The old temp-only merge now routes through the same function (and the same checks).
create or replace function public.sd_merge_temp_product(p_temp text, p_real text, p_by text)
returns text
language sql
security definer
set search_path = public
as $$ select public.sd_link_product(p_temp, p_real, p_by); $$;
revoke all on function public.sd_merge_temp_product(text, text, text) from public, anon;

-- Delete a product that is not in EasyEcom, with everything costed under it. Refused while
-- anything outside the cost sheet uses it (POs, buying plan, inward plan, cutting), and once a
-- PO has frozen it — link those instead. Every deleted row stays recoverable in sd_audit_log.
create or replace function public.sd_delete_unlinked_product(p_code text, p_by text)
returns text
language plpgsql
security definer
set search_path = public
as $$
declare
  v_role public.sd_role := (select public.sd_current_role());
  v_cost public.sd_standard_cost%rowtype;
  v_pos int;
  v_plan int;
  v_other int;
begin
  if v_role not in ('team', 'admin') then
    raise exception 'You do not have permission to delete products.';
  end if;
  p_code := btrim(coalesce(p_code, ''));
  if p_code = '' then
    raise exception 'Product code is required.';
  end if;
  if exists (select 1 from public.sd_product_catalog_mv where upper(product_code) = upper(p_code)) then
    raise exception '% is an EasyEcom product. Only products not in EasyEcom can be deleted; remove it from the list instead.', p_code;
  end if;

  select * into v_cost from public.sd_standard_cost where product_code = p_code;
  if found then
    if v_cost.frozen then
      raise exception '% is frozen by an issued PO and cannot be deleted.', p_code;
    end if;
    if v_cost.neg_stage = 'signed_off' and v_role <> 'admin' then
      raise exception '% has a signed-off cost. Only an admin can delete it.', p_code;
    end if;
  end if;

  select count(*) into v_pos  from public.sd_po_approval where product_code = p_code and deleted_at is null;
  select count(*) into v_plan from public.sd_buying_plan_line where product_code = p_code;
  select (select count(*) from public.sd_inward_plan_entry where product_code = p_code)
       + (select count(*) from public.sd_cutting_register where product_code = p_code)
       + (select count(*) from public.sd_vendor_product_capacity_allocation where product_code = p_code)
    into v_other;
  if v_pos + v_plan + v_other > 0 then
    raise exception '% is still used: % PO(s), % buying-plan line(s), % other record(s). Link it to its EasyEcom product instead, or remove those first.',
      p_code, v_pos, v_plan, v_other;
  end if;

  delete from public.sd_standard_cost_line          where product_code = p_code;
  delete from public.sd_standard_cost_extra_fabric  where product_code = p_code;
  delete from public.sd_standard_cost_rate_history  where product_code = p_code;
  delete from public.sd_cmtp_component              where product_code = p_code;
  delete from public.sd_cmtp_revision               where product_code = p_code;
  delete from public.sd_standard_cost               where product_code = p_code;
  delete from public.sd_temp_product                where temp_code = p_code and status = 'active';
  return p_code;
end;
$$;
revoke all on function public.sd_delete_unlinked_product(text, text) from public, anon;
grant execute on function public.sd_delete_unlinked_product(text, text) to authenticated;
