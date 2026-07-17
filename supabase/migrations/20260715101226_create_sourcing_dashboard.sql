-- SAADAA Sourcing Dashboard: read-only reporting schema.
-- Sheet writes arrive through the service role; authenticated users are read-only.

create table public.pending_po_master (
  id bigserial primary key,
  source_row_key text not null unique,
  po_number text,
  po_created_date timestamptz,
  po_date date,
  item_price numeric,
  po_id text,
  sku text,
  product_description text,
  cp_id text,
  po_detail_id text,
  original_quantity numeric default 0,
  pending_quantity numeric default 0,
  size text,
  po_status text,
  po_created_warehouse text,
  po_created_location_key text,
  po_created_warehouse_c_id text,
  vendor_name text,
  vendor_code text,
  expected_delivery_date date,
  po_ref_num text,
  completed_at_timestamp timestamptz,
  product_variant text,
  product_code text,
  pending_qty_actual numeric default 0,
  po_type text,
  match_flag boolean,
  is_active boolean not null default true,
  sync_token text,
  synced_at timestamptz not null default now()
);

create index pending_po_master_po_ref_num_idx on public.pending_po_master (po_ref_num);
create index pending_po_master_vendor_code_idx on public.pending_po_master (vendor_code);
create index pending_po_master_product_code_idx on public.pending_po_master (product_code);
create index pending_po_master_active_idx on public.pending_po_master (is_active) where is_active;
create unique index pending_po_master_po_detail_id_unique
  on public.pending_po_master (po_detail_id)
  where po_detail_id is not null and btrim(po_detail_id) <> '';

create table public.vendor_type_master (
  vendor_name text primary key,
  vendor_code text,
  vendor_type text,
  merchant_name text,
  status text,
  is_active boolean not null default true,
  sync_token text,
  synced_at timestamptz not null default now()
);

create index vendor_type_master_vendor_code_idx on public.vendor_type_master (vendor_code);

create table public.vendor_master_data (
  vendor_code text primary key,
  vendor_name text,
  onboarding_date date,
  contact_person_name text,
  contact_no text,
  address text,
  primary_type text,
  fob_complete_possible text,
  merchant_name text,
  vendor_preference text,
  total_machines numeric default 0,
  total_active_karigar numeric default 0,
  machines_for_saadaa numeric default 0,
  capacity_per_month numeric default 0,
  karigar_latest numeric default 0,
  karigar_latest_as_of text,
  is_active boolean not null default true,
  sync_token text,
  synced_at timestamptz not null default now()
);

create table public.tna_tracker (
  po_no text primary key,
  po_issued_date date,
  po_qty numeric,
  pp_sample_tna_date date,
  pp_sample_actual_date date,
  pp_sample_delay_days integer,
  gpt_tna_date date,
  gpt_actual_date date,
  gpt_delay_days integer,
  cutting_tna_date date,
  cutting_actual_date_first date,
  cutting_delay_days integer,
  in_line_tna_date date,
  in_line_actual_date date,
  in_line_qc_delay_days integer,
  is_active boolean not null default true,
  sync_token text,
  synced_at timestamptz not null default now()
);

create table public.sync_log (
  id bigserial primary key,
  table_name text,
  rows_synced integer,
  rows_deleted integer,
  status text check (status in ('success', 'error')),
  error_message text,
  started_at timestamptz,
  finished_at timestamptz
);

-- Auth-domain enforcement. This is intentionally server-side and applies to
-- password, OAuth, invite, and admin-created users alike.
create or replace function auth.enforce_saadaa_email_domain()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if new.email is null or lower(new.email) not like '%@saadaa.in' then
    raise exception 'Only @saadaa.in accounts are allowed'
      using errcode = 'check_violation';
  end if;
  return new;
end;
$$;

drop trigger if exists enforce_saadaa_email_domain on auth.users;
create trigger enforce_saadaa_email_domain
  before insert or update of email on auth.users
  for each row execute function auth.enforce_saadaa_email_domain();

-- Read-only Data API surface. The service role bypasses RLS for sync writes.
alter table public.pending_po_master enable row level security;
alter table public.vendor_type_master enable row level security;
alter table public.vendor_master_data enable row level security;
alter table public.tna_tracker enable row level security;
alter table public.sync_log enable row level security;

revoke all on table public.pending_po_master from anon, authenticated;
revoke all on table public.vendor_type_master from anon, authenticated;
revoke all on table public.vendor_master_data from anon, authenticated;
revoke all on table public.tna_tracker from anon, authenticated;
revoke all on table public.sync_log from anon, authenticated;

grant select on table public.pending_po_master to authenticated;
grant select on table public.vendor_type_master to authenticated;
grant select on table public.vendor_master_data to authenticated;
grant select on table public.tna_tracker to authenticated;
grant select on table public.sync_log to authenticated;

create policy "saadaa employees can read pending POs"
  on public.pending_po_master for select to authenticated
  using (lower(coalesce((select auth.jwt()) ->> 'email', '')) like '%@saadaa.in');
create policy "saadaa employees can read vendor types"
  on public.vendor_type_master for select to authenticated
  using (lower(coalesce((select auth.jwt()) ->> 'email', '')) like '%@saadaa.in');
create policy "saadaa employees can read vendor capacity"
  on public.vendor_master_data for select to authenticated
  using (lower(coalesce((select auth.jwt()) ->> 'email', '')) like '%@saadaa.in');
create policy "saadaa employees can read TNA"
  on public.tna_tracker for select to authenticated
  using (lower(coalesce((select auth.jwt()) ->> 'email', '')) like '%@saadaa.in');
create policy "saadaa employees can read sync logs"
  on public.sync_log for select to authenticated
  using (lower(coalesce((select auth.jwt()) ->> 'email', '')) like '%@saadaa.in');

comment on column public.pending_po_master.source_row_key is
  'po_detail_id when present; otherwise a deterministic SHA-256 legacy row key generated by the sync.';
