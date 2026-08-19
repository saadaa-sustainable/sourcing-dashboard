-- De-duplicate: raw fabrics now live only in the Fabric Master. The Buying Plan's
-- material track reads sd_material_codes, so make that view source RAW from the fabric
-- master (single source of truth) and DYED/TRIM from the material master. Then the raw
-- rows can be removed from sd_material_master without the material track losing anything.
create or replace view public.sd_material_codes
with (security_invoker = true) as
  select
    fabric_code                          as material_code,
    'raw'::text                          as material_type,
    coalesce(fabric_name, fabric_code)   as fabric_name,
    null::text                           as colour,
    null::text                           as base_fabric_code
  from public.sd_fabric_master
  where is_active
  union all
  select
    material_code,
    material_type,
    coalesce(name, material_code)        as fabric_name,
    colour,
    base_fabric_code
  from public.sd_material_master
  where is_active and material_type <> 'raw';

grant select on public.sd_material_codes to authenticated;

-- Remove the duplicated raw rows from the material master (kept only in fabric master).
delete from public.sd_material_master where material_type = 'raw';
