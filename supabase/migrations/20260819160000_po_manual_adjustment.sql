-- =====================================================================
-- PO Manual Adjustment tab: two snapshot landing tables (fed from BigQuery on
-- demand via the rate-limited Refresh button and by the daily sync) plus a
-- refresh-audit log that enforces "2 refreshes / hour / user / table".
--
--   BigQuery saadaa-wh.MAPLEMONK.po_qty_manual_adjustment -> sd_po_qty_manual_adjustment
--   BigQuery saadaa-wh.MAPLEMONK.po_qty_cutting_register  -> sd_po_qty_cutting_register
--
-- Snapshot tables (no natural key): each refresh replaces all rows, so there is
-- no PK/upsert — the page reads the latest N by ingestion date.
-- =====================================================================

create table if not exists public.sd_po_qty_manual_adjustment (
  po_no             text,
  sku_code          text,
  manual_adjust_qty numeric,
  po_type           text,
  ingestion_date    timestamptz,
  ingestion_by      text,
  synced_at         timestamptz not null default now()
);
create index if not exists sd_po_qty_manual_adj_ingest_idx
  on public.sd_po_qty_manual_adjustment (ingestion_date desc);

create table if not exists public.sd_po_qty_cutting_register (
  date_of_cutting                 date,
  vendor_code                     text,
  po_number                       text,
  fabric_sku_code                 text,
  item_code                       text,
  cutting_qty                     numeric,
  avg_fabric_consumption_approved numeric,
  width_of_fabric                 text,
  cutting_approval_sheet          text,
  remarks_of_cutting              text,
  fabric_consumed                 numeric,
  type_of_po                      text,
  date_of_ingestion               date,
  ingestion_by                    text,
  synced_at                       timestamptz not null default now()
);
create index if not exists sd_po_qty_cutting_ingest_idx
  on public.sd_po_qty_cutting_register (date_of_ingestion desc);

-- One row per refresh click. The app counts rows in the trailing hour to enforce
-- the per-user, per-source cap (2/hour). 'po' = manual adjustment, 'cutting' = register.
create table if not exists public.sd_adjustment_refresh_log (
  id           bigint generated always as identity primary key,
  user_email   text not null,
  source       text not null check (source in ('po', 'cutting')),
  refreshed_at timestamptz not null default now()
);
create index if not exists sd_adj_refresh_lookup_idx
  on public.sd_adjustment_refresh_log (source, user_email, refreshed_at desc);

alter table public.sd_po_qty_manual_adjustment enable row level security;
alter table public.sd_po_qty_cutting_register  enable row level security;
alter table public.sd_adjustment_refresh_log   enable row level security;

grant select on public.sd_po_qty_manual_adjustment to authenticated;
grant select on public.sd_po_qty_cutting_register  to authenticated;
grant select on public.sd_adjustment_refresh_log   to authenticated;

do $$ begin
  if not exists (select 1 from pg_policies where schemaname='public'
                 and tablename='sd_po_qty_manual_adjustment' and policyname='sd_po_qty_manual_adj_read') then
    execute 'create policy sd_po_qty_manual_adj_read on public.sd_po_qty_manual_adjustment
             for select to authenticated using (true)';
  end if;
  if not exists (select 1 from pg_policies where schemaname='public'
                 and tablename='sd_po_qty_cutting_register' and policyname='sd_po_qty_cutting_read') then
    execute 'create policy sd_po_qty_cutting_read on public.sd_po_qty_cutting_register
             for select to authenticated using (true)';
  end if;
  if not exists (select 1 from pg_policies where schemaname='public'
                 and tablename='sd_adjustment_refresh_log' and policyname='sd_adj_refresh_read') then
    execute 'create policy sd_adj_refresh_read on public.sd_adjustment_refresh_log
             for select to authenticated using (true)';
  end if;
end $$;
