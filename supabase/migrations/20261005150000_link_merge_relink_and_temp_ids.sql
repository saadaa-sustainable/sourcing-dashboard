-- Products not in EasyEcom, round two.
--
-- 1. Linking into an EasyEcom product that already has its own Standard Cost now MERGES the two
--    records: the admin sees both side by side, picks (or types) each rate and which cost sheet
--    to keep, and that choice is passed here as p_merge. The chosen rates are written as a new
--    rate-history row, because the approved standard is read from the LATEST history row —
--    otherwise the old target figures (or whichever record's history happened to be newer)
--    would silently stay the standard.
-- 2. A product linked earlier can be re-linked to a different EasyEcom code (to fix a wrong
--    link). Allowed for a code that is not in EasyEcom, or one that a link record points at.
-- 3. Every product not in EasyEcom carries a TMP-xxxx code. Typed codes ("ABCD", "SAREE")
--    created through the old free-text "Add" row are converted to TMP codes named after what
--    was typed, everywhere they are referenced.

-- Re-point every authored table that carries product_code. Internal: no role check, callers
-- check. sd_product_master is moved only for codes that are not EasyEcom products (an EasyEcom
-- product's master row stays its own).
create or replace function public.sd_repoint_product_code(p_from text, p_to text)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  update public.sd_buying_plan_line                   set product_code = p_to where product_code = p_from;
  update public.sd_po_approval                        set product_code = p_to where product_code = p_from;
  update public.sd_po_delete_request                  set product_code = p_to where product_code = p_from;
  update public.sd_discontinue_request                set product_code = p_to where product_code = p_from;
  update public.sd_inward_plan_entry                  set product_code = p_to where product_code = p_from;
  update public.sd_cutting_register                   set product_code = p_to where product_code = p_from;
  update public.sd_vendor_product_capacity_allocation set product_code = p_to where product_code = p_from;
  if not exists (select 1 from public.sd_product_master where product_code = p_to) then
    update public.sd_product_master set product_code = p_to where product_code = p_from
      and not exists (select 1 from public.sd_ee_product_master g where g.sku like p_from || '%');
  end if;
end;
$$;
revoke all on function public.sd_repoint_product_code(text, text) from public, anon, authenticated;

-- The cost sheet that hangs off a Standard Cost code.
create or replace function public.sd_repoint_cost_sheet(p_from text, p_to text)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  update public.sd_standard_cost_line         set product_code = p_to where product_code = p_from;
  update public.sd_standard_cost_extra_fabric set product_code = p_to where product_code = p_from;
  update public.sd_cmtp_component             set product_code = p_to where product_code = p_from;
  update public.sd_cmtp_revision              set product_code = p_to where product_code = p_from;
end;
$$;
revoke all on function public.sd_repoint_cost_sheet(text, text) from public, anon, authenticated;

drop function if exists public.sd_link_product(text, text, text);

create or replace function public.sd_link_product(p_from text, p_to text, p_by text, p_merge jsonb default null)
returns text
language plpgsql
security definer
set search_path = public
as $$
declare
  v_src public.sd_standard_cost%rowtype;
  v_dst public.sd_standard_cost%rowtype;
  v_from_in_catalog boolean;
  v_job numeric; v_fob numeric; v_efob numeric;
  v_signed boolean;
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
  v_from_in_catalog := exists (select 1 from public.sd_product_catalog_mv where upper(product_code) = upper(p_from));
  if v_from_in_catalog
     and not exists (select 1 from public.sd_temp_product where status = 'merged' and upper(merged_into) = upper(p_from)) then
    raise exception '% is an EasyEcom product that was never linked from another code, so there is no link to change.', p_from;
  end if;
  if not exists (select 1 from public.sd_product_catalog_mv where upper(product_code) = p_to) then
    raise exception '% is not in the product master. Pick a product that exists in EasyEcom.', p_to;
  end if;

  select * into v_src from public.sd_standard_cost where product_code = p_from;
  select * into v_dst from public.sd_standard_cost where upper(product_code) = p_to;

  if v_dst.id is not null and v_src.id is not null then
    -- Both have a cost: merge, with the admin's choice.
    if p_merge is null then
      raise exception '% already has its own Standard Cost. Choose which rates and cost sheet to keep.', p_to;
    end if;
    v_job  := nullif(p_merge ->> 'job_cost', '')::numeric;
    v_fob  := nullif(p_merge ->> 'fob_cost', '')::numeric;
    v_efob := nullif(p_merge ->> 'efob_cost', '')::numeric;
    if v_dst.frozen and (v_job is distinct from v_dst.job_cost or v_fob is distinct from v_dst.fob_cost
                         or v_efob is distinct from v_dst.efob_cost) then
      raise exception '% is frozen by an issued PO: its rates cannot change. Keep its rates to merge.', p_to;
    end if;

    -- Whose cost sheet stays: the other one is dropped (kept in the audit log).
    if coalesce(p_merge ->> 'sheet', 'to') = 'from' then
      delete from public.sd_standard_cost_line         where product_code = v_dst.product_code;
      delete from public.sd_standard_cost_extra_fabric where product_code = v_dst.product_code;
      delete from public.sd_cmtp_component             where product_code = v_dst.product_code;
      perform public.sd_repoint_cost_sheet(p_from, v_dst.product_code);
    else
      delete from public.sd_standard_cost_line         where product_code = p_from;
      delete from public.sd_standard_cost_extra_fabric where product_code = p_from;
      delete from public.sd_cmtp_component             where product_code = p_from;
      update public.sd_cmtp_revision set product_code = v_dst.product_code where product_code = p_from;
    end if;

    -- Both histories stay (history is history), then the chosen rates go on top as the
    -- accepted standard whenever either side had accepted rates.
    update public.sd_standard_cost_rate_history set product_code = v_dst.product_code where product_code = p_from;
    v_signed := v_src.neg_stage = 'signed_off' or v_dst.neg_stage = 'signed_off'
             or exists (select 1 from public.sd_standard_cost_rate_history where product_code = v_dst.product_code);
    if v_signed then
      insert into public.sd_standard_cost_rate_history (product_code, job_cost, fob_cost, efob_cost, accepted_by, accepted_at, note)
      values (v_dst.product_code, v_job, v_fob, v_efob, p_by, now(),
              format('Merged with %s when linking it to %s; rates chosen by the admin.', p_from, v_dst.product_code));
    end if;

    update public.sd_standard_cost set
      job_cost = v_job,
      fob_cost = v_fob,
      efob_cost = v_efob,
      cm_cost = case when p_merge ? 'cm_cost' then nullif(p_merge ->> 'cm_cost', '')::numeric else cm_cost end,
      fabric_code = case when p_merge ? 'fabric_code' then nullif(p_merge ->> 'fabric_code', '') else fabric_code end,
      total_po_avg_cost = case when p_merge ? 'total_po_avg_cost' then nullif(p_merge ->> 'total_po_avg_cost', '')::numeric else total_po_avg_cost end,
      cad_link = case when p_merge ? 'cad_link' then nullif(p_merge ->> 'cad_link', '') else cad_link end,
      rfp_link = case when p_merge ? 'rfp_link' then nullif(p_merge ->> 'rfp_link', '') else rfp_link end,
      documented = documented or v_src.documented,
      neg_stage = case when v_signed then 'signed_off' else neg_stage end,
      status = case when v_signed then 'approved' else status end,
      hidden = false,
      updated_at = now()
    where id = v_dst.id;

    delete from public.sd_standard_cost where id = v_src.id;
  else
    -- Only one side has a cost (or neither): move it across as it is.
    if v_src.id is not null then
      update public.sd_standard_cost set product_code = p_to, updated_at = now() where id = v_src.id;
      update public.sd_standard_cost_rate_history set product_code = p_to where product_code = p_from;
      perform public.sd_repoint_cost_sheet(p_from, p_to);
    end if;
  end if;

  perform public.sd_repoint_product_code(p_from, coalesce(v_dst.product_code, p_to));

  -- Keep the link on record. A re-link moves the earlier records along with it.
  update public.sd_temp_product
     set merged_into = coalesce(v_dst.product_code, p_to), merged_at = now(), merged_by = p_by
   where status = 'merged' and upper(merged_into) = upper(p_from);
  if not v_from_in_catalog then
    insert into public.sd_temp_product as t (temp_code, name, status, merged_into, merged_at, merged_by, created_by)
    values (p_from, p_from, 'merged', coalesce(v_dst.product_code, p_to), now(), p_by, p_by)
    on conflict (temp_code) do update
      set status = 'merged', merged_into = excluded.merged_into, merged_at = excluded.merged_at, merged_by = excluded.merged_by;
  end if;

  return coalesce(v_dst.product_code, p_to);
end;
$$;
revoke all on function public.sd_link_product(text, text, text, jsonb) from public, anon;
grant execute on function public.sd_link_product(text, text, text, jsonb) to authenticated;

create or replace function public.sd_merge_temp_product(p_temp text, p_real text, p_by text)
returns text
language sql
security definer
set search_path = public
as $$ select public.sd_link_product(p_temp, p_real, p_by, null); $$;
revoke all on function public.sd_merge_temp_product(text, text, text) from public, anon;

-- The catalog refresh triggers (20261005130000) fired on EVERY statement on
-- sd_product_master / sd_discontinue_request, even one that changed no rows: a full ~0.85 s
-- catalog refresh per no-op update, and an error when the catalog was being read in the same
-- statement. Now one trigger per event with its transition table, refreshing only when rows
-- actually changed.
create or replace function public.sd_refresh_catalog_trigger()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  n bigint;
begin
  if tg_op = 'DELETE' then
    select count(*) into n from old_rows;
  else
    select count(*) into n from new_rows;
  end if;
  if n > 0 then
    perform public.sd_refresh_derived(true, 'catalog');
  end if;
  return null;
end;
$$;
revoke all on function public.sd_refresh_catalog_trigger() from public, anon, authenticated;

do $$
declare
  t text;
begin
  foreach t in array array['sd_product_master', 'sd_discontinue_request'] loop
    execute format('drop trigger if exists sd_refresh_catalog on public.%I', t);
    execute format('drop trigger if exists sd_refresh_catalog_ins on public.%I', t);
    execute format('drop trigger if exists sd_refresh_catalog_upd on public.%I', t);
    execute format('drop trigger if exists sd_refresh_catalog_del on public.%I', t);
    execute format('create trigger sd_refresh_catalog_ins after insert on public.%I referencing new table as new_rows
                    for each statement execute function public.sd_refresh_catalog_trigger()', t);
    execute format('create trigger sd_refresh_catalog_upd after update on public.%I referencing new table as new_rows
                    for each statement execute function public.sd_refresh_catalog_trigger()', t);
    execute format('create trigger sd_refresh_catalog_del after delete on public.%I referencing old table as old_rows
                    for each statement execute function public.sd_refresh_catalog_trigger()', t);
  end loop;
end;
$$;

-- 3. Typed codes → TMP codes. Each keeps what was typed as its name. The codes are collected
-- first, so no read of the catalog is open while the rows move.
do $$
declare
  v_codes text[];
  v_typed text;
  v_code text;
begin
  select array_agg(s.product_code order by s.created_at, s.id) into v_codes
    from public.sd_standard_cost s
   where s.product_code !~ '^TMP-\d+$'
     and not exists (select 1 from public.sd_product_catalog_mv c where upper(c.product_code) = upper(s.product_code))
     and not exists (select 1 from public.sd_temp_product t where t.temp_code = s.product_code);
  foreach v_typed in array coalesce(v_codes, '{}') loop
    v_code := 'TMP-' || lpad(nextval('public.sd_temp_product_seq')::text, 4, '0');
    insert into public.sd_temp_product (temp_code, name, created_by) values (v_code, v_typed, 'system: typed code converted');
    update public.sd_standard_cost set product_code = v_code where product_code = v_typed;
    update public.sd_standard_cost_rate_history set product_code = v_code where product_code = v_typed;
    perform public.sd_repoint_cost_sheet(v_typed, v_code);
    perform public.sd_repoint_product_code(v_typed, v_code);
    -- Old exports and the audit trail still read: the typed code points at its TMP code.
    insert into public.sd_temp_product (temp_code, name, status, merged_into, merged_at, merged_by, created_by)
    values (v_typed, v_typed, 'merged', v_code, now(), 'system', 'system: typed code converted');
  end loop;
end;
$$;
