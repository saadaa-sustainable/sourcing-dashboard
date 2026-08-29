-- =====================================================================
-- Per-PO cost parameters (spec §5).
--
-- Mahesh's rule: at PO approval, treat CMTP deviation differently from commodity
-- movement. Commodity/fabric (grey / finished-fabric moving day to day) is expected
-- market noise — shown for awareness, never blocked. CMTP vs the product's standard
-- CMTP is shown for review. (The CMTP hard-block — confirm + remark before approving
-- above standard — is DEFERRED for now; these columns pre-provision it.)
--
-- To make that distinction the PO must carry its cost *parameters* separately, not
-- just one blended `rate`. These columns are the "pivoted per-PO cost table":
--   grey_cost, finished_fabric_cost (commodity — informational),
--   cm_cost (CMTP), margin_pct.
-- cm_override_* pre-provision the approved above-standard-CMTP exception (unused yet).
-- =====================================================================

alter table public.sd_po_approval add column if not exists grey_cost            numeric;
alter table public.sd_po_approval add column if not exists finished_fabric_cost numeric;
alter table public.sd_po_approval add column if not exists cm_cost              numeric;
alter table public.sd_po_approval add column if not exists margin_pct           numeric;

-- Approved above-standard-CM exception (the remark is mandatory when it applies).
alter table public.sd_po_approval add column if not exists cm_override_note text;
alter table public.sd_po_approval add column if not exists cm_override_by   text;
alter table public.sd_po_approval add column if not exists cm_override_at   timestamptz;
