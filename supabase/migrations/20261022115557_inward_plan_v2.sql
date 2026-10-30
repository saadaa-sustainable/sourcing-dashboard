-- Isolated Inward Plan V2. No legacy data, policies, views or functions are changed.
-- Sources verified against sourcing-dashboard (jwqqifojsqcdrlquzwqr), 2026-10-22:
-- sd_po_master_raw.po_detail_id = text; sd_ee_grn.grn_detail_id = bigint.
-- Use sd_po_filtered for PO choices and sd_ee_grn_saadaa for receipt reconciliation.
-- References below are snapshots, not FKs to externally refreshed source tables.
-- Approval is header-level, admin-only, matching the legacy inward-plan queue.
-- Custom roles control page visibility, not the approval ladder (20260901120000).
begin;

create schema sd_inward_v2_private;
revoke all on schema sd_inward_v2_private from public, anon, authenticated;

create table public.sd_inward_plan_v2 (
  id uuid primary key default gen_random_uuid(),
  plan_month date not null check (extract(day from plan_month) = 1),
  title text not null check (btrim(title) <> ''),
  remarks text,
  status text not null default 'draft'
    check (status in ('draft', 'pending_l2', 'approved', 'rework', 'rejected')),
  decision_notes text,
  created_by text not null references public.sd_user(email),
  updated_by text not null references public.sd_user(email),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  approved_by text references public.sd_user(email),
  approved_at timestamptz,
  revision integer not null default 1 check (revision > 0),
  check ((status = 'approved') = (approved_by is not null and approved_at is not null)),
  check (status = 'approved' or (approved_by is null and approved_at is null)),
  check (status not in ('rework', 'rejected') or nullif(btrim(decision_notes), '') is not null)
);

create table public.sd_inward_plan_v2_line (
  id uuid primary key default gen_random_uuid(),
  plan_id uuid not null references public.sd_inward_plan_v2(id) on delete restrict,
  source_type text not null default 'po' check (source_type in ('po', 'manual')),
  po_detail_id text,
  po_number text,
  po_ref_num text,
  product_code text not null check (btrim(product_code) <> ''),
  product_variant text,
  sku text not null check (btrim(sku) <> ''),
  size text,
  vendor_code text,
  vendor_name text,
  expected_date date not null,
  inward_qty numeric(18,3) not null check (inward_qty > 0 and inward_qty <> 'NaN'::numeric),
  cost_per_piece numeric(18,4) check (cost_per_piece >= 0 and cost_per_piece <> 'NaN'::numeric),
  remarks text,
  created_by text not null references public.sd_user(email),
  updated_by text not null references public.sd_user(email),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check (source_type <> 'po' or
    (nullif(btrim(po_detail_id), '') is not null and nullif(btrim(po_number), '') is not null))
);
-- A PO line can be scheduled on several dates, once per date in a plan.
create unique index sd_inward_v2_line_source_date_uidx
  on public.sd_inward_plan_v2_line(plan_id, po_detail_id, expected_date)
  where source_type = 'po';
create index sd_inward_v2_line_plan_idx on public.sd_inward_plan_v2_line(plan_id, id);
create index sd_inward_v2_line_po_sku_idx on public.sd_inward_plan_v2_line(po_number, sku);
create index sd_inward_v2_line_ref_idx on public.sd_inward_plan_v2_line(po_ref_num);
create index sd_inward_v2_line_date_idx on public.sd_inward_plan_v2_line(expected_date, id);

create table public.sd_inward_plan_v2_approval_history (
  id bigint generated always as identity primary key,
  plan_id uuid not null references public.sd_inward_plan_v2(id) on delete restrict,
  -- Snapshot IDs deliberately survive removal of a line.
  record_id uuid not null,
  entity text not null check (entity in ('plan', 'line', 'grn_delay')),
  operation text not null check (operation in ('INSERT', 'UPDATE', 'DELETE')),
  from_status text check (from_status in ('draft', 'pending_l2', 'approved', 'rework', 'rejected')),
  to_status text check (to_status in ('draft', 'pending_l2', 'approved', 'rework', 'rejected')),
  changed_by text not null,
  changed_at timestamptz not null default now(),
  before_row jsonb,
  after_row jsonb,
  check ((operation = 'INSERT' and before_row is null and after_row is not null)
    or (operation = 'UPDATE' and before_row is not null and after_row is not null)
    or (operation = 'DELETE' and before_row is not null and after_row is null))
);
create index sd_inward_v2_history_plan_idx
  on public.sd_inward_plan_v2_approval_history(plan_id, changed_at desc, id desc);

create table public.sd_grn_delay_tracker_v2 (
  id uuid primary key default gen_random_uuid(),
  plan_id uuid not null references public.sd_inward_plan_v2(id) on delete restrict,
  line_id uuid not null unique references public.sd_inward_plan_v2_line(id) on delete cascade,
  -- Optional source receipt pointer; reconciliation must match PO detail + SKU,
  -- never attribute a whole PO's received quantity to every SKU.
  grn_detail_id bigint,
  revised_expected_date date,
  received_on date,
  status text not null default 'open' check (status in ('open', 'following_up', 'resolved')),
  delay_reason text,
  follow_up_on date,
  remarks text,
  created_by text not null references public.sd_user(email),
  updated_by text not null references public.sd_user(email),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check (status <> 'resolved' or received_on is not null),
  check (grn_detail_id is null or grn_detail_id > 0)
);
create index sd_grn_delay_v2_plan_idx on public.sd_grn_delay_tracker_v2(plan_id);
create index sd_grn_delay_v2_followup_idx
  on public.sd_grn_delay_tracker_v2(follow_up_on, id) where status <> 'resolved';
create index sd_grn_delay_v2_grn_idx on public.sd_grn_delay_tracker_v2(grn_detail_id)
  where grn_detail_id is not null;
create index sd_inward_v2_month_status_idx on public.sd_inward_plan_v2(plan_month, status, id);
create index sd_inward_v2_owner_idx on public.sd_inward_plan_v2(created_by, id);
create index sd_inward_v2_queue_idx on public.sd_inward_plan_v2(updated_at, id) where status = 'pending_l2';

-- Invoker lookup: only active, provisioned company users may read V2.
-- No user_metadata, unprovisioned-viewer fallback, or local auth bypass.
create function public.sd_inward_v2_role()
returns text language sql stable security invoker set search_path = ''
as $$
  select u.role::text from public.sd_user u
  where auth.uid() is not null and public.sd_is_saadaa()
    and u.email = lower(coalesce((select auth.jwt())->>'email', ''))
    and u.is_active and u.role::text in ('viewer', 'team', 'admin');
$$;
revoke all on function public.sd_inward_v2_role() from public, anon;
grant execute on function public.sd_inward_v2_role() to authenticated;

-- Trigger functions are private and not executable via the Data API.
-- The privileged audit writer is also the mutation guard: all entry points verify
-- the real caller and ownership, including service-role requests carrying no user.
create function sd_inward_v2_private.guard()
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
      content_changed := (new.plan_month, new.title, new.remarks)
        is distinct from (old.plan_month, old.title, old.remarks);
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
      if new.plan_month <> old.plan_month and exists (
        select 1 from public.sd_inward_plan_v2_line x where x.plan_id = old.id
          and date_trunc('month', x.expected_date)::date <> new.plan_month
      ) then raise exception 'Move or remove lines before changing the plan month'; end if;
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
        if date_trunc('month', new.expected_date)::date <> p.plan_month then
          raise exception 'Expected date must belong to the plan month';
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

create function sd_inward_v2_private.audit()
returns trigger language plpgsql security definer set search_path = ''
as $$
declare
  b jsonb := case when tg_op <> 'INSERT' then to_jsonb(old) end;
  a jsonb := case when tg_op <> 'DELETE' then to_jsonb(new) end;
  r jsonb := coalesce(a, b);
  parent_id uuid;
begin
  if auth.uid() is null then raise exception 'Audit requires an authenticated actor'; end if;
  if tg_table_name = 'sd_inward_plan_v2' then
    parent_id := (r->>'id')::uuid;
  elsif tg_table_name = 'sd_inward_plan_v2_line' then
    parent_id := (r->>'plan_id')::uuid;
  else
    parent_id := (r->>'plan_id')::uuid;
  end if;
  insert into public.sd_inward_plan_v2_approval_history
    (plan_id, record_id, entity, operation, from_status, to_status, changed_by, before_row, after_row)
  values (parent_id, (r->>'id')::uuid,
    case tg_table_name when 'sd_inward_plan_v2' then 'plan'
      when 'sd_inward_plan_v2_line' then 'line' else 'grn_delay' end,
    tg_op, case when tg_table_name = 'sd_inward_plan_v2' then b->>'status' end,
    case when tg_table_name = 'sd_inward_plan_v2' then a->>'status' end,
    lower((select auth.jwt())->>'email'), b, a);
  return null;
end;
$$;
revoke all on function sd_inward_v2_private.guard(), sd_inward_v2_private.audit()
  from public, anon, authenticated;

do $$
declare t text;
begin
  foreach t in array array['sd_inward_plan_v2', 'sd_inward_plan_v2_line', 'sd_grn_delay_tracker_v2'] loop
    execute format('create trigger inward_v2_guard before insert or update or delete on public.%I
      for each row execute function sd_inward_v2_private.guard()', t);
    execute format('create trigger inward_v2_audit after insert or update or delete on public.%I
      for each row execute function sd_inward_v2_private.audit()', t);
  end loop;
  foreach t in array array['sd_inward_plan_v2', 'sd_inward_plan_v2_line',
      'sd_inward_plan_v2_approval_history', 'sd_grn_delay_tracker_v2'] loop
    execute format('alter table public.%I enable row level security', t);
    execute format('revoke all on public.%I from public, anon, authenticated', t);
    execute format('grant select on public.%I to authenticated', t);
    execute format('create policy inward_v2_read on public.%I for select to authenticated
      using ((select public.sd_inward_v2_role()) is not null)', t);
  end loop;
end;
$$;

grant insert, update on public.sd_inward_plan_v2 to authenticated;
grant insert, update, delete on public.sd_inward_plan_v2_line, public.sd_grn_delay_tracker_v2 to authenticated;
revoke all on sequence public.sd_inward_plan_v2_approval_history_id_seq from public, anon, authenticated;
-- Append-only history is written exclusively by the private trigger.
create policy inward_v2_insert on public.sd_inward_plan_v2 for insert to authenticated
  with check ((select public.sd_inward_v2_role()) in ('team', 'admin')
    and created_by = lower((select auth.jwt())->>'email'));
create policy inward_v2_update on public.sd_inward_plan_v2 for update to authenticated
  using ((select public.sd_inward_v2_role()) = 'admin'
    or ((select public.sd_inward_v2_role()) = 'team' and created_by = lower((select auth.jwt())->>'email')))
  with check ((select public.sd_inward_v2_role()) = 'admin'
    or ((select public.sd_inward_v2_role()) = 'team' and created_by = lower((select auth.jwt())->>'email')));

-- Both USING and WITH CHECK protect parent ownership. Triggers additionally lock
-- the header to serialize approval against concurrent line and tracker mutations.
do $$
declare t text; parent_predicate text;
begin
  foreach t in array array['sd_inward_plan_v2_line', 'sd_grn_delay_tracker_v2'] loop
    parent_predicate := case t when 'sd_inward_plan_v2_line' then
      'exists (select 1 from public.sd_inward_plan_v2 p where p.id = plan_id
        and (p.created_by = lower((select auth.jwt())->>''email'')
          or (select public.sd_inward_v2_role()) = ''admin''))'
    else
      'exists (select 1 from public.sd_inward_plan_v2_line l
        join public.sd_inward_plan_v2 p on p.id = l.plan_id where l.id = line_id
        and (p.created_by = lower((select auth.jwt())->>''email'')
          or (select public.sd_inward_v2_role()) = ''admin''))' end;
    execute format('create policy inward_v2_write on public.%I for all to authenticated
      using ((select public.sd_inward_v2_role()) in (''team'', ''admin'') and %s)
      with check ((select public.sd_inward_v2_role()) in (''team'', ''admin'') and %s)',
      t, parent_predicate, parent_predicate);
  end loop;
end;
$$;

comment on table public.sd_inward_plan_v2 is
  'V2 header approval; owners can amend all unapproved states. Admin reopens approved plans to rework. No legacy integration.';
comment on table public.sd_inward_plan_v2_line is
  'SKU-level scheduled quantities. Source identifiers are snapshots. Reconcile by PO detail and SKU through warehouse-scoped source views.';
comment on table public.sd_grn_delay_tracker_v2 is
  'Operational follow-up per V2 line; remains editable after plan approval. Does not change approved dates or quantities. No automatic GRN sync.';
commit;
