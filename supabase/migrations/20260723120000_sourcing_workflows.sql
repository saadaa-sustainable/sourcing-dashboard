-- =====================================================================
-- SAADAA Sourcing Dashboard — write-side workflow tables.
--
-- Everything here is prefixed sd_ and is OWNED by Supabase. The existing
-- four tables (pending_po_master, vendor_type_master, vendor_master_data,
-- tna_tracker) remain mirrors of Google Sheets and are untouched.
--
-- ⚠️  NEVER add an sd_ table to CONFIG in apps-script/Code.gs. That sync
--     deactivates every row whose sync_token differs from the current run;
--     one pass would blank the table.
-- =====================================================================

-- ---------------------------------------------------------------------
-- 1. Enums
-- ---------------------------------------------------------------------
create type public.sd_role as enum
  ('viewer', 'supply_chain', 'approver_l1', 'approver_l2', 'admin');

create type public.sd_status as enum
  ('draft', 'submitted', 'pending_l2', 'approved', 'rejected');

-- ---------------------------------------------------------------------
-- 2. Identity
-- ---------------------------------------------------------------------
create table public.sd_user (
  email      text primary key,
  full_name  text,
  role       public.sd_role not null default 'viewer',
  is_active  boolean not null default true,
  created_at timestamptz not null default now()
);

-- Resolves the caller's role once, for use inside RLS policies.
-- security definer so the policy on sd_user cannot recurse into itself.
create or replace function public.sd_current_role()
returns public.sd_role
language sql stable security definer set search_path = ''
as $$
  select coalesce(
    (select u.role from public.sd_user u
      where u.email = lower(coalesce((select auth.jwt()) ->> 'email', ''))
        and u.is_active),
    'viewer'::public.sd_role);
$$;

create or replace function public.sd_is_saadaa()
returns boolean
language sql stable
as $$
  select lower(coalesce((select auth.jwt()) ->> 'email', '')) like '%@saadaa.in';
$$;

create or replace function public.sd_can_write()
returns boolean
language sql stable
as $$
  select public.sd_is_saadaa()
     and public.sd_current_role() in
         ('supply_chain', 'approver_l1', 'approver_l2', 'admin');
$$;

-- ---------------------------------------------------------------------
-- 3. Buying plan
-- ---------------------------------------------------------------------
create table public.sd_buying_plan (
  id              bigserial primary key,
  plan_month      date not null unique,          -- always the 1st
  status          public.sd_status not null default 'draft',
  submitted_by    text,
  submitted_at    timestamptz,
  approved_by     text,
  approved_at     timestamptz,
  rejection_notes text,
  created_at      timestamptz not null default now()
);

create table public.sd_buying_plan_line (
  id               bigserial primary key,
  plan_id          bigint not null references public.sd_buying_plan(id) on delete cascade,
  product_code     text not null,
  product_status   text,
  fabric_type      text,                          -- Woven | Knit
  pending_quantity numeric,                       -- from replenishment; nullable until that module exists
  job_work_qty     numeric not null default 0,
  fob_qty          numeric not null default 0,
  efob_qty         numeric not null default 0,
  standard_value   numeric,
  unique (plan_id, product_code)
);
create index sd_buying_plan_line_plan_idx on public.sd_buying_plan_line (plan_id);

-- ---------------------------------------------------------------------
-- 4. Vendor capacity (append-only weekly log)
-- ---------------------------------------------------------------------
create table public.sd_vendor_capacity_log (
  id                     bigserial primary key,
  vendor_code            text not null,
  vendor_name            text,
  week_of                date not null,           -- Monday
  machines_allocated     numeric,
  active_karigar         numeric,
  capacity_per_month     numeric,
  machines_at_onboarding numeric,                 -- NEW: signed at onboarding
  capacity_signed        numeric,                 -- NEW: committed at onboarding
  submitted_by           text not null,
  submitted_at           timestamptz not null default now(),
  unique (vendor_code, week_of)
);
create index sd_vendor_capacity_week_idx on public.sd_vendor_capacity_log (week_of desc);

create table public.sd_vendor_type_multiplier (
  vendor_type text primary key,                   -- job_work | efob | fob
  label       text not null,
  multiplier  numeric not null,
  stock_days  integer not null
);

-- ⚠️ CONFIRM the E-FOB stock_days with Mahesh: 30 × 1.5 = 45, but the
--    transcript says 41. Multipliers themselves are confirmed.
insert into public.sd_vendor_type_multiplier values
  ('job_work', 'Job work', 1.00, 30),
  ('efob',     'E-FOB',    1.50, 41),
  ('fob',      'FOB',      2.50, 75);

-- ---------------------------------------------------------------------
-- 5. Discontinue
-- ---------------------------------------------------------------------
create table public.sd_discontinue_request (
  id              bigserial primary key,
  product_code    text not null,
  product_variant text not null,
  reason          text,
  status          public.sd_status not null default 'draft',
  requested_by    text,
  requested_at    timestamptz,
  approved_by     text,
  approved_at     timestamptz,
  rejection_notes text
);

-- A plain UNIQUE would let duplicates through once a request is rejected and
-- re-raised. Partial index: only one LIVE request per variant.
create unique index sd_discontinue_live_unique
  on public.sd_discontinue_request (product_code, product_variant)
  where status <> 'rejected';

-- ---------------------------------------------------------------------
-- 6. Approval audit
-- ---------------------------------------------------------------------
create table public.sd_approval_log (
  id           bigserial primary key,
  entity_type  text not null,
  entity_id    text not null,
  entity_label text,
  from_status  public.sd_status,
  to_status    public.sd_status not null,
  actor_email  text not null,
  notes        text,
  created_at   timestamptz not null default now()
);
create index sd_approval_log_entity_idx
  on public.sd_approval_log (entity_type, entity_id, created_at desc);

-- ---------------------------------------------------------------------
-- 7. Active variants view — Discontinue feeds the Buying Plan list
-- ---------------------------------------------------------------------
create view public.sd_active_variants as
select distinct
  btrim(p.product_code)    as product_code,
  btrim(p.product_variant) as product_variant
from public.pending_po_master p
where p.is_active
  and coalesce(btrim(p.product_code), '') <> ''
  and coalesce(btrim(p.product_variant), '') <> ''
  and not exists (
    select 1 from public.sd_discontinue_request d
    where d.product_code    = btrim(p.product_code)
      and d.product_variant = btrim(p.product_variant)
      and d.status = 'approved');

-- ---------------------------------------------------------------------
-- 8. RLS
-- ---------------------------------------------------------------------
alter table public.sd_user                  enable row level security;
alter table public.sd_buying_plan           enable row level security;
alter table public.sd_buying_plan_line      enable row level security;
alter table public.sd_vendor_capacity_log   enable row level security;
alter table public.sd_vendor_type_multiplier enable row level security;
alter table public.sd_discontinue_request   enable row level security;
alter table public.sd_approval_log          enable row level security;

-- Reads: any @saadaa.in account. Writes: supply chain and above.
-- Explicit grants are required — the base migration revoked everything.
grant select on public.sd_user, public.sd_vendor_type_multiplier,
                public.sd_approval_log, public.sd_active_variants
  to authenticated;

grant select, insert, update, delete on
  public.sd_buying_plan, public.sd_buying_plan_line,
  public.sd_vendor_capacity_log, public.sd_discontinue_request
  to authenticated;

grant insert on public.sd_approval_log to authenticated;
grant usage, select on all sequences in schema public to authenticated;

do $$
declare t text;
begin
  foreach t in array array[
    'sd_user', 'sd_buying_plan', 'sd_buying_plan_line',
    'sd_vendor_capacity_log', 'sd_vendor_type_multiplier',
    'sd_discontinue_request', 'sd_approval_log'
  ] loop
    execute format(
      'create policy "saadaa read %1$s" on public.%1$I
         for select to authenticated using (public.sd_is_saadaa())', t);
  end loop;

  foreach t in array array[
    'sd_buying_plan', 'sd_buying_plan_line',
    'sd_vendor_capacity_log', 'sd_discontinue_request'
  ] loop
    execute format(
      'create policy "sourcing write %1$s" on public.%1$I
         for all to authenticated
         using (public.sd_can_write()) with check (public.sd_can_write())', t);
  end loop;
end $$;

create policy "sourcing append approval log" on public.sd_approval_log
  for insert to authenticated with check (public.sd_can_write());

-- ---------------------------------------------------------------------
-- 9. Seed users — REPLACE THESE EMAILS BEFORE RUNNING
-- ---------------------------------------------------------------------
insert into public.sd_user (email, full_name, role) values
  ('website@saadaa.in',  'Pushpendra',  'admin'),
  ('mahesh@saadaa.in',   'Mahesh',      'approver_l2'),
  ('mukesh@saadaa.in',   'Mukesh ji',   'approver_l1'),
  ('durganshu@saadaa.in','Durganshu ji','supply_chain')
on conflict (email) do nothing;
