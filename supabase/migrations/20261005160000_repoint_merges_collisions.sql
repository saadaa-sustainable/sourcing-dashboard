-- Merging two products (sd_link_product with both sides costed) re-points rows that can collide
-- with the target's own rows under a unique key:
--   sd_buying_plan_line (plan_id, product_code)          both products on the same plan
--   sd_discontinue_request (code, variant, size, scope)  both have a live request for the same thing
--   sd_vendor_product_capacity_allocation (vendor, code) both allocated to the same vendor
-- Plan lines are combined: the quantities and value add up (two blanks stay blank) on the target's line (its other
-- fields stay), the source line goes. For the other two the target's own row is kept. Dropped
-- rows stay in sd_audit_log.
create or replace function public.sd_repoint_product_code(p_from text, p_to text)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  update public.sd_buying_plan_line t
     set pending_quantity = case when t.pending_quantity is null and s.pending_quantity is null then null else coalesce(t.pending_quantity, 0) + coalesce(s.pending_quantity, 0) end,
         job_work_qty     = case when t.job_work_qty is null and s.job_work_qty is null then null else coalesce(t.job_work_qty, 0) + coalesce(s.job_work_qty, 0) end,
         fob_qty          = case when t.fob_qty is null and s.fob_qty is null then null else coalesce(t.fob_qty, 0) + coalesce(s.fob_qty, 0) end,
         efob_qty         = case when t.efob_qty is null and s.efob_qty is null then null else coalesce(t.efob_qty, 0) + coalesce(s.efob_qty, 0) end,
         standard_value   = case when t.standard_value is null and s.standard_value is null then null
                                 else coalesce(t.standard_value, 0) + coalesce(s.standard_value, 0) end,
         remark           = concat_ws(' · ', nullif(t.remark, ''), format('includes %s', p_from))
    from public.sd_buying_plan_line s
   where s.product_code = p_from and t.product_code = p_to and s.plan_id = t.plan_id;
  delete from public.sd_buying_plan_line s
   where s.product_code = p_from
     and exists (select 1 from public.sd_buying_plan_line t where t.product_code = p_to and t.plan_id = s.plan_id);

  delete from public.sd_discontinue_request s
   where s.product_code = p_from and s.status <> 'rejected'
     and exists (select 1 from public.sd_discontinue_request t
                  where t.product_code = p_to and t.status <> 'rejected' and t.scope = s.scope
                    and coalesce(t.product_variant, '') = coalesce(s.product_variant, '')
                    and coalesce(t.size, '') = coalesce(s.size, ''));

  delete from public.sd_vendor_product_capacity_allocation s
   where s.product_code = p_from
     and exists (select 1 from public.sd_vendor_product_capacity_allocation t
                  where t.product_code = p_to and t.vendor_code = s.vendor_code);

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
