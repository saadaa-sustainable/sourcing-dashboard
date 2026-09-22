-- Dashboard synopsis helpers: three cheap server-side aggregates so the Objectives tab can
-- show the PO book, the inward-to-sales ratio and the received quantity for a window
-- without paging thousands of rows on every dashboard load.

-- The PO book: how many POs are open right now, how many have completed — the denominator
-- for "open POs as a share of all POs".
create or replace view public.sd_po_book as
select
  (select count(distinct po_ref_num) from public.sd_po_dashboard where pending_qty > 0) as open_pos,
  (select count(distinct po_ref_num) from public.sd_po_completed)                        as completed_pos;
grant select on public.sd_po_book to authenticated;

-- Pieces sold over the four complete weeks the DOQ windows cover (w1..w4), and the window
-- itself, from the same feed the OOS Dashboard's Detail view reads.
create or replace view public.sd_sold_4w as
select
  coalesce(sum(coalesce(w1_qty, 0) + coalesce(w2_qty, 0) + coalesce(w3_qty, 0) + coalesce(w4_qty, 0)), 0) as sold_qty,
  count(*) as skus
from public.sd_doq_window;
grant select on public.sd_sold_4w to authenticated;

-- Pieces received (GRN) between two dates, inclusive of p_from and exclusive of p_to.
create or replace function public.sd_grn_received(p_from date, p_to date)
returns table (received_qty numeric, grn_lines bigint, pos bigint)
language sql stable security invoker set search_path = ''
as $$
  select coalesce(sum(received_quantity), 0), count(*), count(distinct po_number)
  from public.sd_ee_grn
  where grn_created_at >= p_from and grn_created_at < p_to;
$$;
grant execute on function public.sd_grn_received(date, date) to authenticated;
