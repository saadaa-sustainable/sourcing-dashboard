-- =====================================================================
-- Public cutting-register submission via a dynamic link (spec §2 + §3).
--
-- The /fill/[token] route (anon, no login) calls this to submit. SECURITY DEFINER
-- so anon never touches the tables directly: it re-validates the token, snapshots
-- the BOM standard at submission time (§3), inserts the register row, and marks the
-- link single-use (submitted_at + is_active=false). Returns false if the link isn't
-- usable — the caller shows a generic "no longer active" message (no leakage).
-- =====================================================================

create or replace function public.sd_submit_cutting_register(
  p_token        text,
  p_actual       numeric,
  p_cutting_date date,
  p_remarks      text,
  p_name         text,
  p_email        text
)
returns boolean
language plpgsql
security definer
set search_path = ''
as $fn$
declare
  v    public.sd_dynamic_links;
  v_pc text;
  v_q  numeric;
  v_u  text;
begin
  select * into v from public.sd_dynamic_links where token = p_token for update;

  if v.id is null
     or v.is_active is not true
     or v.submitted_at is not null
     or v.expires_at < now() then
    return false;
  end if;

  -- product + BOM snapshot (as the standard was at cutting time)
  select r.product_code into v_pc
    from public.sd_po_master_raw r
   where r.po_ref_num = v.po_ref_num
   limit 1;
  select pm.bom_quantity, pm.bom_uom into v_q, v_u
    from public.sd_product_master pm
   where pm.product_code = v_pc;

  insert into public.sd_cutting_register (
    po_ref_num, product_code, bom_standard_qty, bom_uom,
    actual_consumption_qty, cutting_date, remarks,
    submitted_via, submitted_by_email, submitted_by_name, dynamic_link_id
  ) values (
    v.po_ref_num, v_pc, v_q, v_u,
    p_actual, p_cutting_date, p_remarks,
    'dynamic_link', p_email, p_name, v.id
  );

  update public.sd_dynamic_links
     set submitted_at = now(), is_active = false
   where id = v.id;

  return true;
end;
$fn$;

grant execute on function public.sd_submit_cutting_register(text, numeric, date, text, text, text)
  to anon, authenticated;
