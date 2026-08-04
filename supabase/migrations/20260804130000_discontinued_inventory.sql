-- =====================================================================
-- discontinued_inventory — MIRROR table (Google Sheet = source of truth).
-- "Discontinued Products — Available inventory view": serial-level rows of
-- discontinued-product stock, for inventory-ageing / liquidation planning.
-- Written ONLY by the Apps Script sheet-sync (service role); READ ONLY from the
-- app. No sd_ prefix, matching the other mirror tables (pending_po_master,
-- tna_tracker, ...). Never add an sd_ table to Code.gs CONFIG.
-- =====================================================================

create table if not exists public.discontinued_inventory (
  source_row_key       text primary key,  -- serial_number, or 'sku:<sku>' for no-inventory rows
  sku                  text,
  category             text,
  sub_category         text,
  product_name         text,
  color                text,
  size                 text,
  mrp                  numeric,
  cost                 numeric,
  product_launch_date  date,
  product_state        text,
  available_inventory  numeric,
  inventory_status     text,
  status               text,
  serial_number        text,
  inward_date          date,
  days_in_warehouse    integer,

  -- Sync metadata (Apps Script stamps these on every run).
  is_active            boolean not null default true,
  sync_token           text,
  synced_at            timestamptz not null default now()
);

create index if not exists discontinued_inventory_sku_idx
  on public.discontinued_inventory (sku);
create index if not exists discontinued_inventory_state_idx
  on public.discontinued_inventory (product_state);
create index if not exists discontinued_inventory_active_idx
  on public.discontinued_inventory (is_active) where is_active;

-- Read-only for @saadaa.in; writes come only from the service-role sheet-sync.
alter table public.discontinued_inventory enable row level security;
revoke all on table public.discontinued_inventory from anon, authenticated;
grant select on table public.discontinued_inventory to authenticated;
do $$ begin
  if not exists (select 1 from pg_policies where schemaname='public'
                 and tablename='discontinued_inventory'
                 and policyname='saadaa read discontinued_inventory') then
    execute 'create policy "saadaa read discontinued_inventory" on public.discontinued_inventory
               for select to authenticated using (public.sd_is_saadaa())';
  end if;
end $$;

comment on column public.discontinued_inventory.source_row_key is
  'Serial number when present; otherwise "sku:<sku>" for no-inventory rows. Sync conflict key.';
comment on column public.discontinued_inventory.days_in_warehouse is
  'Ageing as reported by the sheet (used as-is by the dashboard; not recomputed).';
