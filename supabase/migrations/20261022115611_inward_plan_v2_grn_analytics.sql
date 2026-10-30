-- V2 only. Legacy GRN/PO tables are read-only; no source rows or policies change.
-- Inspected 2026-10-22: sd_ee_grn has no size column. Size is from the exact PO detail.
begin;
create view public.sd_inward_v2_system_grn with (security_invoker=true) as
select g.grn_detail_id::text as grn_detail_id, g.grn_id::text as grn_id,
  p.po_detail_id, btrim(p.po_number) as po_number, p.po_ref_num,
  upper(btrim(g.sku)) as sku, nullif(upper(btrim(p.size)),'') as size,
  g.grn_created_at as received_on, g.received_quantity as received_qty, g.synced_at
from public.sd_ee_grn_saadaa g
join public.sd_po_master_raw p on p.po_detail_id=g.purchase_order_detail_id::text
  and btrim(p.po_number)=btrim(g.po_number)
  and upper(btrim(p.sku))=upper(btrim(g.sku))
where nullif(btrim(g.sku),'') is not null and (select public.sd_inward_v2_role()) is not null;
revoke all on public.sd_inward_v2_system_grn from public,anon,authenticated;
grant select on public.sd_inward_v2_system_grn to authenticated;

alter table public.sd_grn_delay_tracker_v2 add column reported_qty numeric(18,3) not null default 0
  check(reported_qty>=0 and reported_qty<>'NaN'::numeric);

-- Snapshot IDs intentionally have no source/tracker FK. Reversed mappings and
-- their snapshots survive removal of a tracker/line; plan headers remain retained.
create table public.sd_inward_v2_grn_reconciliation (
  id uuid primary key default gen_random_uuid(),
  tracker_id uuid not null,
  plan_id uuid not null references public.sd_inward_plan_v2(id) on delete restrict,
  line_id uuid not null,
  grn_detail_id bigint not null check(grn_detail_id>0),
  quantity numeric(18,3) not null check(quantity>0 and quantity<>'NaN'::numeric),
  grn_id text, po_detail_id text not null, po_number text not null, sku text not null, size text,
  system_received_on date not null, system_qty numeric not null, system_synced_at timestamptz not null,
  created_by text not null, created_at timestamptz not null default now(),
  reversed_at timestamptz, reversed_by text, reversal_reason text,
  check((reversed_at is null and reversed_by is null and reversal_reason is null)
    or (reversed_at is not null and reversed_by is not null and nullif(btrim(reversal_reason),'') is not null))
);
create unique index inward_v2_reconcile_active_unique
  on public.sd_inward_v2_grn_reconciliation(tracker_id,grn_detail_id) where reversed_at is null;
create index inward_v2_reconcile_source_idx
  on public.sd_inward_v2_grn_reconciliation(grn_detail_id) where reversed_at is null;
create index inward_v2_reconcile_tracker_idx on public.sd_inward_v2_grn_reconciliation(tracker_id,created_at,id);
create index inward_v2_reconcile_plan_idx on public.sd_inward_v2_grn_reconciliation(plan_id,id);
alter table public.sd_inward_v2_grn_reconciliation enable row level security;
revoke all on public.sd_inward_v2_grn_reconciliation from public,anon,authenticated;
grant select,insert,update on public.sd_inward_v2_grn_reconciliation to authenticated;
create policy inward_v2_reconcile_read on public.sd_inward_v2_grn_reconciliation
  for select to authenticated using((select public.sd_inward_v2_role()) is not null);
create policy inward_v2_reconcile_write on public.sd_inward_v2_grn_reconciliation
  for all to authenticated
  using((select public.sd_inward_v2_role()) in ('team','admin') and exists(
    select 1 from public.sd_inward_plan_v2 p where p.id=plan_id
      and (p.created_by=lower((select auth.jwt())->>'email') or (select public.sd_inward_v2_role())='admin')))
  with check((select public.sd_inward_v2_role()) in ('team','admin') and exists(
    select 1 from public.sd_inward_plan_v2 p where p.id=plan_id
      and (p.created_by=lower((select auth.jwt())->>'email') or (select public.sd_inward_v2_role())='admin')));

create view public.sd_inward_v2_reconciliations with (security_invoker=true) as
select id,tracker_id,plan_id,line_id,grn_detail_id::text as grn_detail_id,quantity,grn_id,
  po_detail_id,po_number,sku,size,system_received_on,system_qty,system_synced_at,
  created_by,created_at,reversed_at,reversed_by,reversal_reason
from public.sd_inward_v2_grn_reconciliation;
revoke all on public.sd_inward_v2_reconciliations from public,anon,authenticated;
grant select on public.sd_inward_v2_reconciliations to authenticated;

alter table public.sd_inward_plan_v2_approval_history
  drop constraint sd_inward_plan_v2_approval_history_entity_check,
  add constraint sd_inward_plan_v2_approval_history_entity_check
    check(entity in ('plan','line','grn_delay','grn_reconciliation'));

create function sd_inward_v2_private.tracker_quantities()
returns trigger language plpgsql security definer set search_path=''
as $$
declare mapped numeric; l public.sd_inward_plan_v2_line%rowtype;
begin
  select coalesce(sum(quantity),0) into mapped from public.sd_inward_v2_grn_reconciliation
    where tracker_id=case when tg_op='DELETE' then old.id else new.id end and reversed_at is null;
  if tg_op='DELETE' then
    if mapped>0 then raise exception 'Reverse GRN reconciliations before removing this tracker or line'; end if;
    return old;
  end if;
  select * into l from public.sd_inward_plan_v2_line where id=new.line_id;
  if not found then raise exception 'Plan line not found'; end if;
  if new.reported_qty<mapped then raise exception 'Reported quantity cannot be below reconciled quantity'; end if;
  if new.reported_qty>0 and (new.received_on is null or new.received_on>(clock_timestamp() at time zone 'Asia/Kolkata')::date) then
    raise exception 'A physical receipt date no later than today is required';
  end if;
  if mapped>0 and exists(select 1 from public.sd_inward_v2_grn_reconciliation r
    where r.tracker_id=new.id and r.reversed_at is null and r.system_received_on<new.received_on) then
    raise exception 'Physical receipt date cannot be later than a reconciled system GRN';
  end if;
  -- This old single-reference field is never proof of reconciliation.
  new.grn_detail_id:=null;
  new.status:=case when mapped>0 and mapped=new.reported_qty then 'resolved'
    when new.follow_up_on is not null then 'following_up' else 'open' end;
  return new;
end;
$$;
create trigger inward_v2_z_tracker_quantities before insert or update or delete
  on public.sd_grn_delay_tracker_v2 for each row execute function sd_inward_v2_private.tracker_quantities();

create function sd_inward_v2_private.tracker_line_integrity()
returns trigger language plpgsql security definer set search_path=''
as $$
begin
  if exists(select 1 from public.sd_grn_delay_tracker_v2 t where t.line_id=old.id
    and t.reported_qty>0 and
      (new.po_detail_id,new.po_number,upper(btrim(new.sku)),nullif(upper(btrim(new.size)),''))
        is distinct from
      (old.po_detail_id,old.po_number,upper(btrim(old.sku)),nullif(upper(btrim(old.size)),''))) then
    raise exception 'Clear the physical receipt report and reverse its reconciliations before changing the line identity';
  end if;
  return new;
end;
$$;
create trigger inward_v2_z_tracker_line before update on public.sd_inward_plan_v2_line
  for each row execute function sd_inward_v2_private.tracker_line_integrity();

create function sd_inward_v2_private.reconciliation_guard()
returns trigger language plpgsql security definer set search_path=''
as $$
declare t public.sd_grn_delay_tracker_v2%rowtype; l public.sd_inward_plan_v2_line%rowtype;
  p public.sd_inward_plan_v2%rowtype; g record; source_used numeric; tracker_used numeric;
  who text:=lower((select auth.jwt())->>'email'); actor text:=public.sd_inward_v2_role();
begin
  if actor is null or actor not in ('team','admin') then raise exception 'Active team/admin session required' using errcode='42501'; end if;
  if tg_op='DELETE' then raise exception 'Reconciliations are retained; reverse with a reason'; end if;
  if tg_op='UPDATE' then
    if (to_jsonb(new)-array['reversed_at','reversed_by','reversal_reason'])
      is distinct from (to_jsonb(old)-array['reversed_at','reversed_by','reversal_reason']) then
      raise exception 'Reconciliation details are immutable';
    end if;
    if old.reversed_at is not null or nullif(btrim(new.reversal_reason),'') is null then
      raise exception 'An active reconciliation and a reversal reason are required';
    end if;
  end if;
  select * into t from public.sd_grn_delay_tracker_v2 where id=new.tracker_id;
  if not found then raise exception 'Tracker not found'; end if;
  select * into p from public.sd_inward_plan_v2 where id=t.plan_id for update;
  select * into t from public.sd_grn_delay_tracker_v2 where id=new.tracker_id for update;
  if p.created_by<>who and actor<>'admin' then raise exception 'Only owner/admin may reconcile' using errcode='42501'; end if;
  -- Serializes allocation and reversal of one real GRN across ALL trackers/cadences.
  perform pg_advisory_xact_lock(84621,hashtext(new.grn_detail_id::text));
  if tg_op='UPDATE' then
    new.reversed_at:=clock_timestamp(); new.reversed_by:=who; new.reversal_reason:=btrim(new.reversal_reason);
    return new;
  end if;
  select * into l from public.sd_inward_plan_v2_line where id=t.line_id;
  select * into g from public.sd_inward_v2_system_grn where grn_detail_id=new.grn_detail_id::text;
  if not found then raise exception 'Specific system GRN detail not found in the warehouse-scoped source'; end if;
  if g.po_detail_id is distinct from l.po_detail_id or g.po_number is distinct from btrim(l.po_number)
    or g.sku is distinct from upper(btrim(l.sku))
    or g.size is distinct from nullif(upper(btrim(l.size)),'') then
    raise exception 'GRN must match the exact PO detail, PO number, SKU and size';
  end if;
  if t.reported_qty<=0 or t.received_on is null or g.received_on<t.received_on
    or g.received_on>(clock_timestamp() at time zone 'Asia/Kolkata')::date then
    raise exception 'GRN date must be on/after the physical receipt and no later than today';
  end if;
  if g.received_qty is null or g.received_qty<=0 or g.received_qty='NaN'::numeric then
    raise exception 'GRN has no positive system quantity';
  end if;
  select coalesce(sum(quantity),0) into source_used from public.sd_inward_v2_grn_reconciliation
    where grn_detail_id=new.grn_detail_id and reversed_at is null;
  select coalesce(sum(quantity),0) into tracker_used from public.sd_inward_v2_grn_reconciliation
    where tracker_id=t.id and reversed_at is null;
  if new.quantity+source_used>g.received_qty then raise exception 'Reconciliation exceeds remaining quantity on this specific GRN'; end if;
  if new.quantity+tracker_used>t.reported_qty then raise exception 'Reconciliation exceeds tracker quantity awaiting system GRN'; end if;
  new.plan_id:=t.plan_id; new.line_id:=t.line_id;
  new.grn_id:=g.grn_id; new.po_detail_id:=g.po_detail_id; new.po_number:=g.po_number;
  new.sku:=g.sku; new.size:=g.size; new.system_received_on:=g.received_on;
  new.system_qty:=g.received_qty; new.system_synced_at:=g.synced_at;
  new.created_by:=who; new.created_at:=clock_timestamp();
  new.reversed_at:=null; new.reversed_by:=null; new.reversal_reason:=null;
  return new;
end;
$$;
create trigger inward_v2_reconciliation_guard before insert or update or delete
  on public.sd_inward_v2_grn_reconciliation for each row execute function sd_inward_v2_private.reconciliation_guard();

create function sd_inward_v2_private.reconciliation_audit()
returns trigger language plpgsql security definer set search_path=''
as $$
begin
  if auth.uid() is null then raise exception 'Authenticated actor required'; end if;
  insert into public.sd_inward_plan_v2_approval_history
    (plan_id,record_id,entity,operation,changed_by,before_row,after_row)
  values(new.plan_id,new.id,'grn_reconciliation',tg_op,lower((select auth.jwt())->>'email'),
    case when tg_op='UPDATE' then to_jsonb(old)||jsonb_build_object('grn_detail_id',old.grn_detail_id::text) end,
    to_jsonb(new)||jsonb_build_object('grn_detail_id',new.grn_detail_id::text));
  update public.sd_grn_delay_tracker_v2 set updated_at=clock_timestamp() where id=new.tracker_id;
  return null;
end;
$$;
create trigger inward_v2_reconciliation_audit after insert or update on public.sd_inward_v2_grn_reconciliation
  for each row execute function sd_inward_v2_private.reconciliation_audit();

create function public.sd_inward_v2_report_grn(p_line uuid,p_quantity numeric,p_received_on date,
  p_reason text,p_follow_up date,p_remarks text,p_version timestamptz default null)
returns uuid language plpgsql security invoker set search_path=''
as $$
declare t public.sd_grn_delay_tracker_v2%rowtype; l public.sd_inward_plan_v2_line%rowtype; result_id uuid;
begin
  select * into l from public.sd_inward_plan_v2_line where id=p_line;
  if not found then raise exception 'Line not found'; end if;
  perform 1 from public.sd_inward_plan_v2 where id=l.plan_id for update;
  select * into t from public.sd_grn_delay_tracker_v2 where line_id=p_line for update;
  if found then
    if p_version is null or p_version<>t.updated_at then raise exception 'Tracker changed. Reload before saving'; end if;
    update public.sd_grn_delay_tracker_v2 set reported_qty=p_quantity,received_on=p_received_on,
      delay_reason=p_reason,follow_up_on=p_follow_up,remarks=p_remarks where id=t.id returning id into result_id;
  else
    if p_version is not null then raise exception 'Tracker was removed. Reload before saving'; end if;
    insert into public.sd_grn_delay_tracker_v2(plan_id,line_id,reported_qty,received_on,delay_reason,follow_up_on,remarks,created_by,updated_by)
    values(l.plan_id,p_line,p_quantity,p_received_on,p_reason,p_follow_up,p_remarks,
      lower(auth.jwt()->>'email'),lower(auth.jwt()->>'email')) returning id into result_id;
  end if;
  return result_id;
end;
$$;
create function public.sd_inward_v2_reconcile_grn(p_tracker uuid,p_grn_detail text,p_quantity numeric,p_version timestamptz)
returns uuid language plpgsql security invoker set search_path=''
as $$
declare t public.sd_grn_delay_tracker_v2%rowtype; result_id uuid;
begin
  perform 1 from public.sd_inward_plan_v2 p join public.sd_grn_delay_tracker_v2 tr on tr.plan_id=p.id
    where tr.id=p_tracker for update of p;
  select * into t from public.sd_grn_delay_tracker_v2 where id=p_tracker for update;
  if not found or p_version is null or p_version<>t.updated_at then raise exception 'Tracker missing or changed. Reload before reconciling'; end if;
  if p_grn_detail !~ '^[1-9][0-9]*$' then raise exception 'A specific GRN detail ID is required'; end if;
  insert into public.sd_inward_v2_grn_reconciliation(tracker_id,plan_id,line_id,grn_detail_id,quantity,
    po_detail_id,po_number,sku,system_received_on,system_qty,system_synced_at,created_by)
  values(t.id,t.plan_id,t.line_id,p_grn_detail::bigint,p_quantity,'source','source','source',current_date,0,now(),
    lower(auth.jwt()->>'email')) returning id into result_id;
  return result_id;
end;
$$;
create function public.sd_inward_v2_reverse_grn(p_id uuid,p_reason text,p_version timestamptz)
returns void language plpgsql security invoker set search_path=''
as $$
declare r public.sd_inward_v2_grn_reconciliation%rowtype; t public.sd_grn_delay_tracker_v2%rowtype;
begin
  select * into r from public.sd_inward_v2_grn_reconciliation where id=p_id;
  if not found then raise exception 'Reconciliation not found'; end if;
  perform 1 from public.sd_inward_plan_v2 where id=r.plan_id for update;
  select * into t from public.sd_grn_delay_tracker_v2 where id=r.tracker_id for update;
  if not found or p_version is null or p_version<>t.updated_at then raise exception 'Tracker changed. Reload before reversing'; end if;
  update public.sd_inward_v2_grn_reconciliation set reversed_at=clock_timestamp(),reversal_reason=p_reason where id=p_id;
end;
$$;
revoke all on function public.sd_inward_v2_report_grn(uuid,numeric,date,text,date,text,timestamptz),
  public.sd_inward_v2_reconcile_grn(uuid,text,numeric,timestamptz),
  public.sd_inward_v2_reverse_grn(uuid,text,timestamptz) from public,anon;
grant execute on function public.sd_inward_v2_report_grn(uuid,numeric,date,text,date,text,timestamptz),
  public.sd_inward_v2_reconcile_grn(uuid,text,numeric,timestamptz),
  public.sd_inward_v2_reverse_grn(uuid,text,timestamptz) to authenticated;
revoke all on all functions in schema sd_inward_v2_private from public,anon,authenticated;
commit;
