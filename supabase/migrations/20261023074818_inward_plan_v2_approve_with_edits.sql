-- V2 only. Save edits and approve under one header lock/transaction.
-- No source data, legacy workflow or existing records are rewritten.
begin;
create function public.sd_inward_v2_approve_with_edits(
  p_header jsonb,p_lines jsonb,p_notes text,p_version timestamptz
) returns uuid language plpgsql security invoker set search_path='' as $$
declare h public.sd_inward_plan_v2%rowtype; plan_uuid uuid;
begin
  if public.sd_inward_v2_role() is distinct from 'admin' then
    raise exception 'Only admin may approve with edits' using errcode='42501';
  end if;
  if jsonb_typeof(p_header) is distinct from 'object' or nullif(p_header->>'id','') is null then
    raise exception 'Select an existing pending plan';
  end if;
  if length(coalesce(p_notes,''))>4000 then raise exception 'Remarks must be at most 4000 characters'; end if;
  select * into h from public.sd_inward_plan_v2 where id=(p_header->>'id')::uuid for update;
  if not found then raise exception 'Plan not found'; end if;
  if h.status<>'pending_l2' then raise exception 'Only pending plans can be approved with edits'; end if;
  if p_version is null or p_version<>h.updated_at then raise exception 'Plan changed. Reload before approving'; end if;
  plan_uuid:=public.sd_inward_v2_save(p_header,p_lines,p_version);
  select * into h from public.sd_inward_plan_v2 where id=plan_uuid;
  perform public.sd_inward_v2_decide(plan_uuid,'approve',p_notes,h.updated_at);
  return plan_uuid;
end;
$$;
revoke all on function public.sd_inward_v2_approve_with_edits(jsonb,jsonb,text,timestamptz) from public,anon;
grant execute on function public.sd_inward_v2_approve_with_edits(jsonb,jsonb,text,timestamptz) to authenticated;
commit;
