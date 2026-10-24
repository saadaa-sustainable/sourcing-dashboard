-- V2 product-code planning. Existing SKU rows and history remain intact.
-- Product rows store ONE PO/product quantity, no synthetic SKU or allocation.
-- Deploy before the matching application changes. No legacy/source writes.
begin;
alter table public.sd_inward_plan_v2_line
  add column planning_level text not null default 'sku' check(planning_level in ('sku','product')),
  alter column sku drop not null;
-- The base migration's anonymous source-reference check requires a detail ID.
do $$ declare c record; begin
  for c in select conname from pg_constraint where conrelid='public.sd_inward_plan_v2_line'::regclass
    and contype='c' and pg_get_constraintdef(oid) like '%po_detail_id%' loop
    execute format('alter table public.sd_inward_plan_v2_line drop constraint %I',c.conname);
  end loop;
end $$;
alter table public.sd_inward_plan_v2_line add constraint inward_v2_planning_identity check (
  (planning_level='product' and source_type='po' and nullif(btrim(po_number),'') is not null
    and po_detail_id is null and sku is null and size is null and product_variant is null)
  or (planning_level='sku' and nullif(btrim(sku),'') is not null
    and (source_type<>'po' or (nullif(btrim(po_detail_id),'') is not null and nullif(btrim(po_number),'') is not null)))
);
-- Null generated keys keep existing SKU schedules unchanged.
alter table public.sd_inward_plan_v2_line add column product_schedule_key text generated always as
  (case when planning_level='product' then product_code else null end) stored;
alter table public.sd_inward_plan_v2_line add constraint inward_v2_product_date_unique
  unique(plan_id,po_number,product_schedule_key,expected_date) deferrable initially deferred;
create view public.sd_inward_v2_product_po with(security_invoker=true) as
select po_number,product_code,min(po_ref_num) as po_ref_num,min(vendor_code) as vendor_code,
  min(vendor_name) as vendor_name,sum(pending_qty) as pending_qty,
  min(expected_delivery_date) as expected_delivery_date,
  case when count(distinct item_price)=1 then min(item_price) else null end as item_price
from public.sd_po_filtered
where po_status='Approved' and pending_qty>0 and nullif(btrim(product_code),'') is not null
  and nullif(btrim(po_number),'') is not null
  and (select public.sd_inward_v2_role()) is not null
group by po_number,product_code
having count(distinct coalesce(vendor_code,''))<=1;
revoke all on public.sd_inward_v2_product_po from public,anon,authenticated;
grant select on public.sd_inward_v2_product_po to authenticated;
create or replace function sd_inward_v2_private.validate_plan(p_id uuid)
returns void language plpgsql security invoker set search_path='' as $$
begin
  if not exists(select 1 from public.sd_inward_plan_v2_line where plan_id=p_id) then
    raise exception 'Add at least one PO/product line before submitting';
  end if;
  if exists(select 1 from public.sd_inward_plan_v2_line l join public.sd_inward_plan_v2 h on h.id=l.plan_id
    where l.plan_id=p_id and (l.expected_date<h.period_start or l.expected_date>h.period_end)) then
    raise exception 'Line date is outside the planning period';
  end if;
  if exists(select 1 from public.sd_inward_plan_v2_line l
    left join public.sd_inward_v2_product_po s on s.po_number=l.po_number and s.product_code=l.product_code
    where l.plan_id=p_id and l.planning_level='product' and s.po_number is null) then
    raise exception 'PO/product is no longer approved and open';
  end if;
  if exists(select 1 from public.sd_inward_plan_v2_line l
    join public.sd_inward_v2_product_po s on s.po_number=l.po_number and s.product_code=l.product_code
    where l.plan_id=p_id and l.planning_level='product'
    group by l.po_number,l.product_code,s.pending_qty having sum(l.inward_qty)>s.pending_qty) then
    raise exception 'Scheduled product quantity exceeds pending PO/product quantity';
  end if;
  if exists(select 1 from public.sd_inward_plan_v2_line l
    left join public.sd_po_filtered s on s.po_detail_id=l.po_detail_id
    where l.plan_id=p_id and l.planning_level='sku' and (l.source_type<>'po' or s.po_detail_id is null
      or s.po_status<>'Approved' or coalesce(s.pending_qty,0)<=0 or s.sku is distinct from l.sku
      or s.po_number is distinct from l.po_number or s.size is distinct from l.size)) then
    raise exception 'Legacy PO/SKU is unavailable or no longer approved/open';
  end if;
  if exists(select 1 from public.sd_inward_plan_v2_line l join public.sd_po_filtered s on s.po_detail_id=l.po_detail_id
    where l.plan_id=p_id and l.planning_level='sku' group by l.po_detail_id,s.pending_qty
    having sum(l.inward_qty)>s.pending_qty) then raise exception 'Scheduled quantity exceeds PO line pending quantity'; end if;
  if exists(select 1 from public.sd_inward_plan_v2_line where plan_id=p_id
    group by po_number,product_code having count(distinct planning_level)>1) then
    raise exception 'Cannot mix product and legacy SKU planning for the same PO/product in one plan';
  end if;
end;
$$;
create or replace function sd_inward_v2_private.workflow_guard()
returns trigger language plpgsql security definer set search_path=''
as $$
declare src record;
begin
  if tg_table_name='sd_inward_plan_v2' then
    -- Identity/status authorization is enforced by the earlier inward_v2_guard.
    if tg_op='INSERT' then new.submitted_at:=null;
    elsif new.status='pending_l2' and (old.status<>'pending_l2' or new.period_kind is distinct from old.period_kind or new.period_start is distinct from old.period_start) then
      if clock_timestamp() >= ((new.period_start +
        case when new.period_kind='weekly' then 1 else 2 end)::timestamp at time zone 'Asia/Kolkata') then
        raise exception 'Submission deadline passed: weekly Monday EOD / monthly 2nd EOD (IST). Choose a future period';
      end if;
      new.submitted_at:=clock_timestamp();
      -- Full line validation occurs after the save transaction, including resubmission.
    else new.submitted_at:=old.submitted_at;
    end if;
    if tg_op='UPDATE' and new.status='approved' and old.status<>'approved' then
      if old.submitted_at is null or old.submitted_at>=old.submission_deadline then
        raise exception 'A valid on-time submission is required before approval';
      end if;
      perform sd_inward_v2_private.validate_plan(old.id);
    end if;
  else
    if tg_op='DELETE' then return old; end if;
    if new.planning_level='product' then
      select * into src from public.sd_inward_v2_product_po
        where po_number=new.po_number and product_code=new.product_code;
      if not found then raise exception 'Select an approved, open PO/product'; end if;
      new.source_type:='po'; new.po_ref_num:=src.po_ref_num;
      new.vendor_code:=src.vendor_code; new.vendor_name:=src.vendor_name;
      new.po_detail_id:=null; new.sku:=null; new.size:=null; new.product_variant:=null;
      return new;
    end if;
    if new.source_type<>'po' then raise exception 'V2 workflow requires a real PO/SKU source'; end if;
    select * into src from public.sd_po_filtered where po_detail_id=new.po_detail_id;
    if not found or src.sku is null or src.product_code is null or src.po_number is null then
      raise exception 'Select a valid PO/SKU from the source';
    end if;
    -- Source descriptions are authoritative, never trust client-supplied vendor/SKU.
    new.po_number:=src.po_number; new.po_ref_num:=src.po_ref_num;
    new.product_code:=src.product_code; new.product_variant:=src.product_variant;
    new.sku:=src.sku; new.size:=src.size;
    new.vendor_code:=src.vendor_code; new.vendor_name:=src.vendor_name;
  end if;
  return new;
end;
$$;
create or replace function public.sd_inward_v2_save(p_header jsonb, p_lines jsonb, p_version timestamptz default null)
returns uuid language plpgsql security invoker set search_path=''
as $$
declare h public.sd_inward_plan_v2%rowtype; plan_uuid uuid; item jsonb; line_uuid uuid;
begin
  if public.sd_inward_v2_role() not in ('team','admin') or public.sd_inward_v2_role() is null then
    raise exception 'Active team/admin access required' using errcode='42501';
  end if;
  if jsonb_typeof(p_header) is distinct from 'object' or jsonb_typeof(p_lines) is distinct from 'array'
    or jsonb_array_length(p_lines)>500 then raise exception 'Invalid plan payload (maximum 500 lines)'; end if;
  plan_uuid:=nullif(p_header->>'id','')::uuid;
  if plan_uuid is null then
    insert into public.sd_inward_plan_v2(plan_month,title,remarks,period_kind,period_start,created_by,updated_by)
    values(date_trunc('month',(p_header->>'period_start')::date)::date,
      p_header->>'title',nullif(p_header->>'remarks',''),p_header->>'period_kind',
      (p_header->>'period_start')::date,lower(auth.jwt()->>'email'),lower(auth.jwt()->>'email'))
    returning id into plan_uuid;
  else
    select * into h from public.sd_inward_plan_v2 where id=plan_uuid for update;
    if not found then raise exception 'Plan not found'; end if;
    if p_version is null or p_version<>h.updated_at then
      raise exception 'This plan changed. Reload it before saving';
    end if;
    if h.status='approved' then raise exception 'Approved plans must be reopened by admin'; end if;
    if h.created_by<>lower(auth.jwt()->>'email') and public.sd_inward_v2_role()<>'admin' then
      raise exception 'Only owner/admin may edit' using errcode='42501';
    end if;
    update public.sd_inward_plan_v2 set
      plan_month=date_trunc('month',(p_header->>'period_start')::date)::date,
      period_kind=p_header->>'period_kind',period_start=(p_header->>'period_start')::date,
      title=p_header->>'title',remarks=nullif(p_header->>'remarks','')
      where id=plan_uuid;
  end if;
  if exists(select 1 from jsonb_array_elements(p_lines) j
    where nullif(j->>'id','') is not null and not exists(
      select 1 from public.sd_inward_plan_v2_line l where l.id=(j->>'id')::uuid and l.plan_id=plan_uuid
    )) then raise exception 'A line belongs to another plan or was removed'; end if;
  if (select count(*) from jsonb_array_elements(p_lines) j where nullif(j->>'id','') is not null)
    <> (select count(distinct j->>'id') from jsonb_array_elements(p_lines) j where nullif(j->>'id','') is not null)
    then raise exception 'Duplicate line IDs'; end if;
  delete from public.sd_inward_plan_v2_line l where l.plan_id=plan_uuid and not exists(
    select 1 from jsonb_array_elements(p_lines) j where nullif(j->>'id','')::uuid=l.id);
  for item in select * from jsonb_array_elements(p_lines) loop
    line_uuid:=nullif(item->>'id','')::uuid;
    if line_uuid is null then
      insert into public.sd_inward_plan_v2_line(plan_id,planning_level,po_number,po_detail_id,product_code,sku,
        expected_date,inward_qty,cost_per_piece,remarks,created_by,updated_by)
      values(plan_uuid,coalesce(item->>'planning_level','sku'),item->>'po_number',item->>'po_detail_id',coalesce(item->>'product_code','source'),'source',(item->>'expected_date')::date,
        (item->>'inward_qty')::numeric,nullif(item->>'cost_per_piece','')::numeric,
        nullif(item->>'remarks',''),lower(auth.jwt()->>'email'),lower(auth.jwt()->>'email'));
    else
      update public.sd_inward_plan_v2_line set planning_level=coalesce(item->>'planning_level','sku'),
        po_number=item->>'po_number',product_code=coalesce(item->>'product_code','source'),po_detail_id=item->>'po_detail_id',
        expected_date=(item->>'expected_date')::date,inward_qty=(item->>'inward_qty')::numeric,
        cost_per_piece=nullif(item->>'cost_per_piece','')::numeric,remarks=nullif(item->>'remarks','')
        where id=line_uuid and plan_id=plan_uuid;
    end if;
  end loop;
  return plan_uuid;
end;
$$;
create or replace function sd_inward_v2_private.tracker_line_integrity()
returns trigger language plpgsql security definer set search_path=''
as $$
begin
  if exists(select 1 from public.sd_grn_delay_tracker_v2 t where t.line_id=old.id
    and t.reported_qty>0 and
      (new.planning_level,new.product_code,new.po_detail_id,new.po_number,upper(btrim(new.sku)),nullif(upper(btrim(new.size)),''))
        is distinct from
      (old.planning_level,old.product_code,old.po_detail_id,old.po_number,upper(btrim(old.sku)),nullif(upper(btrim(old.size)),''))) then
    raise exception 'Clear the physical receipt report and reverse its reconciliations before changing the line identity';
  end if;
  return new;
end;
$$;
create or replace view public.sd_inward_v2_system_grn with (security_invoker=true) as
select g.grn_detail_id::text as grn_detail_id, g.grn_id::text as grn_id,
  p.po_detail_id, btrim(p.po_number) as po_number, p.po_ref_num,
  upper(btrim(g.sku)) as sku, nullif(upper(btrim(p.size)),'') as size,
  g.grn_created_at as received_on, g.received_quantity as received_qty, g.synced_at, p.product_code
from public.sd_ee_grn_saadaa g
join public.sd_po_master_raw p on p.po_detail_id=g.purchase_order_detail_id::text
  and btrim(p.po_number)=btrim(g.po_number)
  and upper(btrim(p.sku))=upper(btrim(g.sku))
where nullif(btrim(g.sku),'') is not null and (select public.sd_inward_v2_role()) is not null;
create or replace function sd_inward_v2_private.reconciliation_guard()
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
  if l.planning_level='product' then
    if g.po_number is distinct from btrim(l.po_number) or g.product_code is distinct from l.product_code then
      raise exception 'GRN must match the planned PO and product code';
    end if;
  elsif g.po_detail_id is distinct from l.po_detail_id or g.po_number is distinct from btrim(l.po_number)
    or g.sku is distinct from upper(btrim(l.sku)) or g.size is distinct from nullif(upper(btrim(l.size)),'') then
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
revoke all on all functions in schema sd_inward_v2_private from public,anon,authenticated;
commit;
