-- =====================================================================
-- Link a product's Standard Cost to the fabric whose rate feeds its CM matrix.
-- The CM cost matrix pulls the Fabric column (read-only, "yellow") from
-- sd_fabric_cost_base.finished_fabric_cost for this fabric_code.
-- =====================================================================

alter table public.sd_standard_cost add column if not exists fabric_code text;
