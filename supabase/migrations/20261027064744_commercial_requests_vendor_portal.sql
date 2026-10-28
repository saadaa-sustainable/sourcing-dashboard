-- Vendor portal access is provisioned explicitly by an active SAADAA admin.
-- All writes go through authenticated server actions using the server-only service client.
-- Browser roles get no write grants, including the legacy generic approval path.
create table public.sd_commercial_vendor_account (
  user_id uuid primary key references auth.users(id),
  email text not null,
  vendor_code text not null,
  is_active boolean not null default true,
  updated_by text not null,
  updated_at timestamptz not null default now()
);
alter table public.sd_commercial_vendor_account enable row level security;
revoke all on public.sd_commercial_vendor_account from anon, authenticated;
grant select on public.sd_commercial_vendor_account to authenticated;
grant all on public.sd_commercial_vendor_account to service_role;
create policy commercial_account_self on public.sd_commercial_vendor_account
for select to authenticated using (user_id = (select auth.uid()));

create table public.sd_commercial_upload (
  path text primary key,
  uploaded_by text not null,
  created_at timestamptz not null default now()
);
alter table public.sd_commercial_upload enable row level security;
revoke all on public.sd_commercial_upload from anon, authenticated;
grant select, insert on public.sd_commercial_upload to service_role;

alter table public.sd_vendor_commercial_request
  add column revision integer not null default 1,
  add column details jsonb not null default '{}'::jsonb check (jsonb_typeof(details) = 'object'),
  add column submission_key uuid,
  add column submitted_at timestamptz,
  add column updated_at timestamptz not null default now(),
  add column last_actor text,
  add column decision_notes text,
  add column decided_at timestamptz,
  add column decided_by text,
  add column approved_amount numeric check (approved_amount >= 0),
  add column processing_status text not null default 'pending' check (processing_status in ('pending','processed')),
  add column processed_amount numeric check (processed_amount >= 0),
  add column processed_reference text,
  add column processed_at timestamptz,
  add column processed_by text;
create unique index commercial_submission_key on public.sd_vendor_commercial_request(submission_key) where submission_key is not null;

drop policy if exists "sourcing write sd_vendor_commercial_request" on public.sd_vendor_commercial_request;
drop policy if exists "saadaa read sd_vendor_commercial_request" on public.sd_vendor_commercial_request;
revoke all on public.sd_vendor_commercial_request from anon, authenticated;
grant select on public.sd_vendor_commercial_request to authenticated;
grant all on public.sd_vendor_commercial_request to service_role;
grant usage, select on sequence public.sd_vendor_commercial_request_id_seq to service_role;
create policy commercial_request_read on public.sd_vendor_commercial_request for select to authenticated using (
  exists(select 1 from public.sd_user u where lower(u.email) = lower(auth.jwt()->>'email') and u.is_active and lower(u.email) like '%@saadaa.in')
  or exists(select 1 from public.sd_commercial_vendor_account a where a.user_id = auth.uid() and a.is_active and a.vendor_code = sd_vendor_commercial_request.vendor_code)
);

create table public.sd_commercial_request_event (
  id bigint generated always as identity primary key,
  request_id bigint not null references public.sd_vendor_commercial_request(id),
  actor_email text not null,
  occurred_at timestamptz not null default now(),
  before_values jsonb,
  after_values jsonb not null
);
create index commercial_event_request on public.sd_commercial_request_event(request_id,id);
alter table public.sd_commercial_request_event enable row level security;
revoke all on public.sd_commercial_request_event from anon, authenticated, service_role;
grant select on public.sd_commercial_request_event to authenticated;
grant select, insert on public.sd_commercial_request_event to service_role;
grant usage, select on sequence public.sd_commercial_request_event_id_seq to service_role;
create policy commercial_event_read on public.sd_commercial_request_event for select to authenticated using (
  exists(select 1 from public.sd_vendor_commercial_request r where r.id = request_id)
  and (
    public.sd_is_saadaa()
    or exists(select 1 from public.sd_commercial_vendor_account a where a.user_id = auth.uid() and a.is_active
      and a.vendor_code = after_values->>'vendor_code'
      and a.vendor_code = coalesce(before_values->>'vendor_code', after_values->>'vendor_code'))
  )
);

create function public.sd_commercial_revision() returns trigger language plpgsql security invoker set search_path = '' as $$
begin
  if tg_op = 'UPDATE' then
    new.revision := old.revision + 1;
    new.id := old.id;
    new.requested_by := old.requested_by;
    new.requested_at := old.requested_at;
    new.submission_key := old.submission_key;
    -- An approved financial record can only be processed or explicitly reopened.
    if old.status = 'approved' and new.status = 'approved' and
      (to_jsonb(new) - array['revision','updated_at','last_actor','processing_status','processed_amount','processed_reference','processed_at','processed_by'])
      is distinct from
      (to_jsonb(old) - array['revision','updated_at','last_actor','processing_status','processed_amount','processed_reference','processed_at','processed_by']) then
      raise exception 'Approved request is locked; reopen it before amending';
    end if;
  end if;
  new.updated_at := now();
  if new.last_actor is null then raise exception 'Commercial actor required'; end if;
  return new;
end $$;
create trigger commercial_revision before insert or update on public.sd_vendor_commercial_request
for each row execute function public.sd_commercial_revision();

create function public.sd_commercial_event() returns trigger language plpgsql security invoker set search_path = '' as $$
begin
  insert into public.sd_commercial_request_event(request_id,actor_email,before_values,after_values)
  values(new.id,new.last_actor,case when tg_op = 'UPDATE' then to_jsonb(old) else null end,to_jsonb(new));
  return new;
end $$;
create trigger commercial_event after insert or update on public.sd_vendor_commercial_request
for each row execute function public.sd_commercial_event();
revoke execute on function public.sd_commercial_revision(), public.sd_commercial_event() from public, anon, authenticated;
notify pgrst, 'reload schema';
