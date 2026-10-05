-- Store the product catalog and product status (read thousands of times a day: every product
-- dropdown, Category Mapping, buying plan, approvals). Both match ~7.5k EasyEcom SKUs to product
-- codes by prefix on every read: 565 ms and 308 ms each, after the RLS fix.
--
-- Same pattern as 20261005110000: the work lives in a *_mv, the view keeps its name and columns.
-- Both views applied RLS (saadaa users only). The stored copies are not exposed to the API at
-- all; the thin views read them as owner and apply the same saadaa-only check themselves.

create materialized view if not exists public.sd_product_catalog_mv as
  with codes as materialized (
    select distinct u.product_code
      from (
        select sd_product_master.product_code from public.sd_product_master
        union
        select sd_active_variants.product_code from public.sd_active_variants
        union
        select case when length(btrim(product_variant)) > 2
                    then left(btrim(product_variant), length(btrim(product_variant)) - 2)
                    else btrim(product_variant) end
          from public.sd_ee_product_master
         where product_variant is not null and btrim(product_variant) <> ''
      ) u
     where u.product_code is not null and btrim(u.product_code) <> ''
  )
  select c.product_code,
         m.product_name,
         coalesce(nullif(btrim(pm.category), ''), m.category) as category,
         coalesce(nullif(btrim(pm.sub_category), ''), m.sub_category) as sub_category
    from codes c
    left join public.sd_product_master pm on pm.product_code = c.product_code
    left join lateral (
      select (array_agg(g.product_name order by length(g.sku)) filter (where coalesce(btrim(g.product_name), '') <> ''))[1] as product_name,
             mode() within group (order by initcap(lower(btrim(g.category_type)))) filter (where coalesce(btrim(g.category_type), '') <> '') as category,
             mode() within group (order by initcap(lower(btrim(g.sub_category)))) filter (where coalesce(btrim(g.sub_category), '') <> '') as sub_category
        from public.sd_ee_product_master g
       where g.sku like c.product_code || '%'
    ) m on true;
create unique index if not exists sd_product_catalog_mv_pk on public.sd_product_catalog_mv (product_code);

create materialized view if not exists public.sd_ee_product_code_status_mv as
  with codes as materialized (
    select distinct u.product_code
      from (
        select sd_product_master.product_code from public.sd_product_master
        union
        select sd_active_variants.product_code from public.sd_active_variants
      ) u
     where u.product_code is not null and btrim(u.product_code) <> ''
  ), matched as (
    select (select c.product_code from codes c
             where g.sku like c.product_code || '%'
             order by length(c.product_code) desc limit 1) as product_code,
           case upper(btrim(regexp_replace(g.product_state, '\s+', ' ', 'g')))
             when 'ONGOING' then 'Ongoing'
             when 'NPD - NOT LAUNCHED YET' then 'NPD - Not Launched Yet'
             when 'NPD' then 'NPD'
             when 'TO BE DISCONTINUED' then 'To Be Discontinued'
             when 'DISCONTINUED' then 'Discontinued'
             when 'SKU CREATE BUT NOT LAUNCH' then 'SKU Create But Not Launch'
             when '' then null
             else initcap(btrim(g.product_state))
           end as state,
           case
             when upper(g.weave_type) = any (array['KNIT', 'KNITTED', 'TERRY']) then 'Knitted'
             when upper(g.weave_type) like '%WOVEN%' or upper(g.weave_type) like '%TWILL%' then 'Woven'
             else null
           end as norm_weave
      from public.sd_ee_product_master g
  ), ranked as (
    select product_code, state, norm_weave,
           case
             when state is null then 99
             when state = 'Ongoing' then 1
             when state = 'NPD' then 2
             when state = 'NPD - Not Launched Yet' then 3
             when state = 'SKU Create But Not Launch' then 4
             when state = 'To Be Discontinued' then 5
             when state = 'Discontinued' then 6
             else 7
           end as prio
      from matched
  )
  select product_code,
         (array_agg(state order by prio))[1] as product_status,
         mode() within group (order by norm_weave) filter (where norm_weave is not null) as fabric_type
    from ranked
   where product_code is not null
   group by product_code;
create unique index if not exists sd_ee_product_code_status_mv_pk on public.sd_ee_product_code_status_mv (product_code);

-- The views keep their names, columns and who can read them: saadaa users only.
create or replace view public.sd_product_catalog with (security_invoker = false) as
  select product_code, product_name, category, sub_category
    from public.sd_product_catalog_mv
   where (select public.sd_is_saadaa());

create or replace view public.sd_ee_product_code_status with (security_invoker = false) as
  select product_code, product_status, fabric_type
    from public.sd_ee_product_code_status_mv
   where (select public.sd_is_saadaa());

revoke all on public.sd_product_catalog_mv, public.sd_ee_product_code_status_mv from anon, authenticated;
grant select on public.sd_product_catalog_mv, public.sd_ee_product_code_status_mv to service_role;
revoke all on public.sd_product_catalog, public.sd_ee_product_code_status from anon;

-- ── One refresh routine for every stored result, each refreshed only when its sources move ──
create or replace function public.sd_refresh_derived(force boolean default false, only_group text default null)
returns table (name text, refreshed boolean, took_ms int)
language plpgsql
security definer
set search_path = public
as $$
declare
  grn_sig     timestamptz;
  catalog_sig timestamptz;
  sig  timestamptz;
  last timestamptz;
  t0   timestamptz;
  mv   text;
  grp  text;
begin
  for mv, grp in
    select * from (values ('sd_grn_value_mv', 'grn'),
                          ('sd_product_first_grn_mv', 'grn'),
                          ('sd_product_catalog_mv', 'catalog'),
                          ('sd_ee_product_code_status_mv', 'catalog')) v(m, g)
     where only_group is null or v.g = only_group
  loop
    if grp = 'grn' then
      grn_sig := coalesce(grn_sig, (select max(synced_at) from public.sd_po_grn_mapping));
      sig := grn_sig;
    else
      -- Synced sources only; dashboard edits (product master, discontinuations) refresh at once
      -- through the statement triggers below.
      catalog_sig := coalesce(catalog_sig, greatest(
        (select max(synced_at) from public.sd_ee_product_master),
        (select max(synced_at) from public.pending_po_master)));
      sig := catalog_sig;
    end if;

    select r.source_synced into last from public.sd_derived_refresh r where r.name = mv;
    if force or last is null or sig is distinct from last then
      t0 := clock_timestamp();
      execute format('refresh materialized view concurrently public.%I', mv);
      took_ms := (extract(epoch from clock_timestamp() - t0) * 1000)::int;
      insert into public.sd_derived_refresh as d (name, source_synced, refreshed_at, took_ms)
      values (mv, sig, now(), took_ms)
      on conflict on constraint sd_derived_refresh_pkey do update set source_synced = excluded.source_synced,
                                       refreshed_at  = excluded.refreshed_at,
                                       took_ms       = excluded.took_ms;
      name := mv; refreshed := true; return next;
    else
      name := mv; refreshed := false; took_ms := 0; return next;
    end if;
  end loop;
end;
$$;
drop function if exists public.sd_refresh_derived(boolean);
revoke all on function public.sd_refresh_derived(boolean, text) from public, anon, authenticated;

-- A product added or re-categorised on the dashboard, or a discontinuation approved, shows in
-- every dropdown straight away rather than at the next 10-minute check.
create or replace function public.sd_refresh_catalog_trigger()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  perform public.sd_refresh_derived(true, 'catalog');
  return null;
end;
$$;
revoke all on function public.sd_refresh_catalog_trigger() from public, anon, authenticated;

drop trigger if exists sd_refresh_catalog on public.sd_product_master;
create trigger sd_refresh_catalog after insert or update or delete on public.sd_product_master
  for each statement execute function public.sd_refresh_catalog_trigger();
drop trigger if exists sd_refresh_catalog on public.sd_discontinue_request;
create trigger sd_refresh_catalog after insert or update or delete on public.sd_discontinue_request
  for each statement execute function public.sd_refresh_catalog_trigger();

-- The GRN index for date-bounded reads (dashboard tiles, receivable month), paired with the
-- code now ordering those reads by (grn_created_at, grn_detail_id).
create index if not exists sd_ee_grn_created_id_idx on public.sd_ee_grn (grn_created_at, grn_detail_id);
-- (grn_created_at, grn_detail_id) covers everything the date-only index did.
drop index if exists public.sd_ee_grn_created_at_idx;
