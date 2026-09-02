-- =====================================================================
-- DOQ Dashboard (port of the sheet "DOQ 3-Table Generator").
--
-- sd_doq_window — per-SKU window aggregates computed by BqSync.gs
-- doqWindows() from the full BigQuery daily history (the sheet read RAW
-- SALES + Inventory report; our equivalent is saadaa_inventory_planning's
-- per-day rows: daily_quantity = that day's sales, current_stock = that
-- day's stock). Windows, matching the sheet:
--   d1  latest day          l7  last 7 days
--   w1..w4  last 4 COMPLETE Mon-Sun weeks (w1 most recent)
--   at  all time
-- Per window: qty sold, available days (stock > 0), OOS days.
--
-- sd_doq_window_meta — one row describing the windows (labels, ranges,
-- distinct-day counts) so the dashboard titles match the data exactly.
--
-- The dashboard joins these to sd_oos_calculation for category
-- (product_status), price (Selling Price), 45-day DOQ, stock and
-- in-process — and applies sd_oos_sku_exclusion, so the excluded-SKU list
-- governs this view too. Category = Product State for now; COM STATUS
-- grouping is pending a source from the team.
-- =====================================================================

create table public.sd_doq_window (
  sku       text primary key,
  d1_qty    double precision, d1_avail integer, d1_oos integer,
  l7_qty    double precision, l7_avail integer, l7_oos integer,
  w1_qty    double precision, w1_avail integer, w1_oos integer,
  w2_qty    double precision, w2_avail integer, w2_oos integer,
  w3_qty    double precision, w3_avail integer, w3_oos integer,
  w4_qty    double precision, w4_avail integer, w4_oos integer,
  at_qty    double precision, at_avail integer, at_oos integer,
  synced_at timestamptz
);

create table public.sd_doq_window_meta (
  id        integer primary key,
  windows   jsonb not null,
  synced_at timestamptz
);

alter table public.sd_doq_window enable row level security;
alter table public.sd_doq_window_meta enable row level security;
create policy "saadaa read sd_doq_window" on public.sd_doq_window
  for select to authenticated using (public.sd_is_saadaa());
create policy "saadaa read sd_doq_window_meta" on public.sd_doq_window_meta
  for select to authenticated using (public.sd_is_saadaa());
grant select on public.sd_doq_window, public.sd_doq_window_meta to authenticated;
