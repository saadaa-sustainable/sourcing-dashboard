-- V2 only: weekly/monthly periods, IST submission cutoffs, atomic saves/review.
-- Weekly: Monday EOD. Monthly: 2nd EOD. User confirmed 2026-10-22.
-- No approval cutoff or deadline override has been authorized.
begin;
alter table public.sd_inward_plan_v2
  add column period_kind text not null default 'monthly' check (period_kind in ('weekly','monthly')),
  add column period_start date,
  add column submitted_at timestamptz;
-- Preserve pre-existing V2 rows without invoking user-session audit guards.
alter table public.sd_inward_plan_v2 disable trigger user;
update public.sd_inward_plan_v2 set period_start = plan_month;
alter table public.sd_inward_plan_v2 enable trigger user;
alter table public.sd_inward_plan_v2
  alter column period_start set not null,
  add column period_end date generated always as (
    case when period_kind='weekly' then period_start+6
      else (period_start + interval '1 month' - interval '1 day')::date end) stored,
  -- Exclusive instant: Monday's following midnight / the 3rd at 00:00 IST.
  add column submission_deadline timestamptz generated always as (
    (period_start + case when period_kind='weekly' then 1 else 2 end)::timestamp
      at time zone 'Asia/Kolkata') stored,
  add constraint inward_v2_period_start_check check (
    (period_kind='weekly' and extract(isodow from period_start)=1)
    or (period_kind='monthly' and extract(day from period_start)=1)),
  add constraint inward_v2_period_month_check check (
    plan_month=date_trunc('month',period_start)::date);
create index sd_inward_v2_period_idx on public.sd_inward_plan_v2(period_start desc, id);

-- Permit atomic swaps while rejecting duplicate final schedules at commit.
drop index public.sd_inward_v2_line_source_date_uidx;
alter table public.sd_inward_plan_v2_line add constraint sd_inward_v2_line_source_date_unique
   unique(plan_id,po_detail_id,expected_date) deferrable initially deferred;
alter table public.sd_inward_plan_v2 add constraint inward_v2_finite_period
   check (isfinite(period_start) and isfinite(plan_month));

-- Match UI page grants in the database as well as the server action.
create or replace function public.sd_inward_v2_role()
returns text language sql stable security invoker set search_path=''
as $$
  select u.role::text from public.sd_user u
  where auth.uid() is not null and public.sd_is_saadaa()
    and u.email=lower(coalesce((select auth.jwt())->>'email','')) and u.is_active
    and u.role::text in ('viewer','team','admin')
    and (u.role::text='admin'
      or not exists(select 1 from public.sd_user_role ur where ur.user_email=u.email)
      or exists(select 1 from public.sd_user_role ur join public.sd_custom_role r on r.id=ur.role_id
        where ur.user_email=u.email and '/inward-plan-v2'=any(r.pages)));
$$;

create or replace function sd_inward_v2_private.guard()
returns trigger language plpgsql security definer set search_path = ''
as $$
declare
  who text := lower(coalesce((select auth.jwt())->>'email', ''));
  actor_role text := public.sd_inward_v2_role();
  p public.sd_inward_plan_v2%rowtype;
  l public.sd_inward_plan_v2_line%rowtype;
  content_changed boolean;
begin
  if actor_role is null or actor_role not in ('team', 'admin') then
    raise exception 'An active team or admin session is required' using errcode = '42501';
  end if;
  if tg_table_name = 'sd_inward_plan_v2' then
    if tg_op = 'DELETE' then
      raise exception 'Retain plan headers and history; discard through rejection';
    end if;
    if tg_op = 'INSERT' then
      if new.status <> 'draft' then raise exception 'New plans start as drafts'; end if;
      new.created_by := who;
      new.created_at := now();
      new.revision := 1;
      new.decision_notes := null;
      new.approved_by := null;
      new.approved_at := null;
    else
      if old.created_by <> who and actor_role <> 'admin' then
        raise exception 'Only the owner or an admin may amend a plan' using errcode = '42501';
      end if;
      if new.id <> old.id or new.created_by <> old.created_by or new.created_at <> old.created_at then
        raise exception 'Plan identity and creator are immutable';
      end if;
      content_changed := (new.plan_month, new.title, new.remarks, new.period_kind, new.period_start)
        is distinct from (old.plan_month, old.title, old.remarks, old.period_kind, old.period_start);
      if old.status = 'approved' then
        if actor_role <> 'admin' or new.status <> 'rework' or content_changed then
          raise exception 'Approved plans are locked; admin must reopen to rework first';
        end if;
        new.revision := old.revision + 1;
      else
        new.revision := old.revision;
        if content_changed and old.status in ('rework', 'rejected') then
          new.status := 'pending_l2';
          new.decision_notes := null;
        end if;
        if new.status in ('approved', 'rework', 'rejected') and new.status <> old.status then
          if actor_role <> 'admin' or old.status <> 'pending_l2' then
            raise exception 'Only admin may decide a pending plan' using errcode = '42501';
          end if;
        elsif new.status <> old.status and new.status <> 'pending_l2' then
          raise exception 'Invalid plan transition';
        end if;
        if new.status = old.status and new.decision_notes is distinct from old.decision_notes then
          raise exception 'Decision remarks change only with a decision';
        end if;
      end if;
    end if;
    if new.status = 'approved' then
      new.approved_by := who;
      new.approved_at := now();
    else
      new.approved_by := null;
      new.approved_at := null;
    end if;
    if (new.status = 'approved' or (new.status = 'pending_l2' and old.status = 'draft')) and not exists (
      select 1 from public.sd_inward_plan_v2_line x where x.plan_id = new.id
    ) then raise exception 'Cannot submit or approve an empty plan'; end if;
  else
    if tg_table_name = 'sd_inward_plan_v2_line' then
      if tg_op = 'UPDATE' and (new.id <> old.id or new.plan_id <> old.plan_id) then
        raise exception 'Line identity and parent are immutable';
      end if;
      select * into p from public.sd_inward_plan_v2
        where id = case when tg_op = 'DELETE' then old.plan_id else new.plan_id end for update;
    else
      if tg_op = 'UPDATE' and (new.id <> old.id or new.line_id <> old.line_id) then
        raise exception 'Tracker identity and line are immutable';
      end if;
      select * into l from public.sd_inward_plan_v2_line
        where id = case when tg_op = 'DELETE' then old.line_id else new.line_id end;
      -- During ON DELETE CASCADE, the line has already gone. Its guarded delete
      -- supplied authorization; the tracker audit trigger still records the removal.
      if tg_op = 'DELETE' and l.id is null then return old; end if;
      select * into p from public.sd_inward_plan_v2 where id = l.plan_id for update;
      if tg_op <> 'DELETE' then new.plan_id := l.plan_id; end if;
    end if;
    if p.id is null then raise exception 'Plan not found'; end if;
    if p.created_by <> who and actor_role <> 'admin' then
      raise exception 'Only the owner or admin may amend this record' using errcode = '42501';
    end if;
    if tg_table_name = 'sd_inward_plan_v2_line' then
      if p.status = 'approved' then raise exception 'Approved plan lines are locked'; end if;
      if tg_op <> 'DELETE' then
        if new.expected_date < p.period_start or new.expected_date > p.period_end then
          raise exception 'Expected date must belong to the planning period';
        end if;
      end if;
      if p.status in ('rework', 'rejected') then
        update public.sd_inward_plan_v2 set status = 'pending_l2', decision_notes = null where id = p.id;
      end if;
    end if;
    if tg_op = 'INSERT' then
      new.created_by := who;
      new.created_at := now();
    elsif tg_op = 'UPDATE' then
      if new.created_by <> old.created_by or new.created_at <> old.created_at then
        raise exception 'Creator and creation timestamp are immutable';
      end if;
    end if;
  end if;
  if tg_op = 'DELETE' then return old; end if;
  new.updated_by := who;
  new.updated_at := now();
  return new;
end;
$$;

create function sd_inward_v2_private.validate_plan(p_id uuid)
returns void language plpgsql security invoker set search_path=''
as $$
begin
  if not exists(select 1 from public.sd_inward_plan_v2_line where plan_id=p_id) then
    raise exception 'Add at least one PO/SKU line before submitting';
  end if;
  if exists (
    select 1 from public.sd_inward_plan_v2_line l
    join public.sd_inward_plan_v2 h on h.id=l.plan_id
    left join public.sd_po_filtered s on s.po_detail_id=l.po_detail_id
    where l.plan_id=p_id and (
      l.source_type<>'po' or s.po_detail_id is null or s.po_status<>'Approved'
      or coalesce(s.pending_qty,0)<=0 or s.sku is distinct from l.sku
      or s.po_number is distinct from l.po_number or s.size is distinct from l.size
      or l.expected_date<h.period_start or l.expected_date>h.period_end)
  ) then raise exception 'A line is outside the period or its PO/SKU is unavailable or no longer approved/open'; end if;
  if exists (
    select 1 from public.sd_inward_plan_v2_line l
    join public.sd_po_filtered s on s.po_detail_id=l.po_detail_id
    where l.plan_id=p_id group by l.po_detail_id,s.pending_qty
    having sum(l.inward_qty)>s.pending_qty
  ) then raise exception 'Scheduled quantity exceeds the PO line pending quantity'; end if;
end;
$$;

create function sd_inward_v2_private.workflow_guard()
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
create trigger inward_v2_workflow_guard before insert or update
  on public.sd_inward_plan_v2 for each row execute function sd_inward_v2_private.workflow_guard();
create trigger inward_v2_workflow_guard before insert or update
  on public.sd_inward_plan_v2_line for each row execute function sd_inward_v2_private.workflow_guard();

create function sd_inward_v2_private.check_period()
returns trigger language plpgsql security definer set search_path=''
as $$
declare h public.sd_inward_plan_v2%rowtype;
begin
  select * into h from public.sd_inward_plan_v2 where id=new.id;
  if exists(select 1 from public.sd_inward_plan_v2_line l where l.plan_id=h.id
    and (l.expected_date<h.period_start or l.expected_date>h.period_end)) then
    raise exception 'Every line date must belong to the planning period';
  end if;
  if h.status='pending_l2' and tg_op='UPDATE' and old.status<>new.status
    and exists(select 1 from public.sd_inward_plan_v2_line where plan_id=h.id) then
    perform sd_inward_v2_private.validate_plan(h.id);
  end if;
  return null;
end;
$$;
create constraint trigger inward_v2_check_period after insert or update
  on public.sd_inward_plan_v2 deferrable initially deferred
  for each row execute function sd_inward_v2_private.check_period();

create function sd_inward_v2_private.touch_plan()
returns trigger language plpgsql security definer set search_path=''
as $$
begin
  update public.sd_inward_plan_v2 set updated_at=clock_timestamp()
    where id=case when tg_op='DELETE' then old.plan_id else new.plan_id end;
  return null;
end;
$$;
create trigger inward_v2_touch_plan after insert or update or delete on public.sd_inward_plan_v2_line
  for each row execute function sd_inward_v2_private.touch_plan();

-- RPCs run as the caller: grants/RLS and private guards still apply.
create function public.sd_inward_v2_save(p_header jsonb, p_lines jsonb, p_version timestamptz default null)
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
      insert into public.sd_inward_plan_v2_line(plan_id,po_detail_id,product_code,sku,
        expected_date,inward_qty,cost_per_piece,remarks,created_by,updated_by)
      values(plan_uuid,item->>'po_detail_id','source','source',(item->>'expected_date')::date,
        (item->>'inward_qty')::numeric,nullif(item->>'cost_per_piece','')::numeric,
        nullif(item->>'remarks',''),lower(auth.jwt()->>'email'),lower(auth.jwt()->>'email'));
    else
      update public.sd_inward_plan_v2_line set po_detail_id=item->>'po_detail_id',
        expected_date=(item->>'expected_date')::date,inward_qty=(item->>'inward_qty')::numeric,
        cost_per_piece=nullif(item->>'cost_per_piece','')::numeric,remarks=nullif(item->>'remarks','')
        where id=line_uuid and plan_id=plan_uuid;
    end if;
  end loop;
  return plan_uuid;
end;
$$;

create function public.sd_inward_v2_decide(p_id uuid,p_action text,p_notes text,p_version timestamptz)
returns void language plpgsql security invoker set search_path=''
as $$
declare h public.sd_inward_plan_v2%rowtype; next_status text;
begin
  select * into h from public.sd_inward_plan_v2 where id=p_id for update;
  if not found then raise exception 'Plan not found'; end if;
  if p_version is null or p_version<>h.updated_at then raise exception 'Plan changed. Reload before deciding'; end if;
  if p_action='submit' then
    if h.status not in ('draft','rework','rejected') then raise exception 'This plan cannot be submitted in its current state'; end if;
    if h.created_by<>lower(auth.jwt()->>'email') and public.sd_inward_v2_role()<>'admin' then
      raise exception 'Only owner/admin may submit' using errcode='42501';
    end if;
    next_status:='pending_l2';
  else
    if public.sd_inward_v2_role() is distinct from 'admin' then
      raise exception 'Only admin may review plans' using errcode='42501';
    end if;
    if p_action='reopen' then
      if h.status<>'approved' then raise exception 'Only approved plans can be reopened'; end if;
      next_status:='rework';
    else
      if h.status<>'pending_l2' then raise exception 'Only pending plans can be reviewed'; end if;
      next_status:=case p_action when 'approve' then 'approved' when 'rework' then 'rework'
        when 'reject' then 'rejected' else null end;
    end if;
    if next_status is null then raise exception 'Invalid decision'; end if;
    if next_status in ('rework','rejected') and nullif(btrim(p_notes),'') is null then
      raise exception 'A reason is required for rework, rejection or reopening';
    end if;
  end if;
  update public.sd_inward_plan_v2 set status=next_status,decision_notes=nullif(btrim(p_notes),'') where id=p_id;
end;
$$;
revoke all on function public.sd_inward_v2_save(jsonb,jsonb,timestamptz),
  public.sd_inward_v2_decide(uuid,text,text,timestamptz) from public,anon;
grant execute on function public.sd_inward_v2_save(jsonb,jsonb,timestamptz),
  public.sd_inward_v2_decide(uuid,text,text,timestamptz) to authenticated;
revoke all on all functions in schema sd_inward_v2_private from public,anon,authenticated;
commit;
