-- In process, net of manual adjustments — the team's own rule (their syncApprovedPOItems sheet:
-- Pending_Qty_Actual = max(0, pending_qty − manual_adjust_qty), the adjustment summed per PO
-- reference × SKU from po_qty_manual_adjustment). Same PO filters as before. 324 approved PO
-- lines carry an adjustment; total in process 149,594 → 129,392 on 7 Oct 2026.
create or replace view public.sd_sku_in_process with (security_invoker = true) as
with po as (
  select po_ref_num, sku, sum(coalesce(pending_qty, 0)) as pending, count(*) as lines
  from public.sd_po_master_raw
  where warehouse = 'SAADAA SUSTAINABLE DESIGNS AND TECHNOLOGIES PRIVATE LIMITED'
    and coalesce(vendor_name, '') not in (
      'SAADAA SUSTAINABLE DESIGNS AND TECHNOLOGIES PRIVATE LIMITED', 'EBO001', 'Holisol - BLR',
      'Marketing SAADAA', 'Defective Goods', 'SAADAA - GRN', 'HOLISOL-MH', 'NEXSSYS Photoshoot Studio')
    and po_status = 'Approved'
    and po_date > '2025-08-01'
    and sku is not null and btrim(sku) <> ''
  group by po_ref_num, sku
), adj as (
  select po_no, sku_code, sum(coalesce(manual_adjust_qty, 0)) as qty
  from public.sd_po_qty_manual_adjustment
  group by po_no, sku_code
)
select
  replace(upper(btrim(po.sku)), '_', '')                            as sku_key,
  sum(greatest(0, po.pending - coalesce(adj.qty, 0)))::numeric      as in_process_qty,
  sum(po.lines)::bigint                                             as open_lines,
  count(distinct po.po_ref_num)::bigint                             as open_pos
from po
left join adj on adj.po_no = po.po_ref_num and adj.sku_code = po.sku
group by 1;
comment on view public.sd_sku_in_process is
  'In process per SKU = sum over approved POs of max(0, pending qty - manual adjustment) (SAADAA warehouse, own/internal vendors excluded, po_date > 2025-08-01). Replaces BigQuery total_inprogress.';
