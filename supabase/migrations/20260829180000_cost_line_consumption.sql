-- =====================================================================
-- Per-size fabric consumption on the Standard Cost detail lines.
--
-- The Standard Cost detail is reworked into the two-entity model: Fabric Cost
-- (referenced from the Fabric Cost master) + CMTP (the CMTP tab) → computed Final
-- Price. Per size, fabric cost = finished-fabric rate × consumption(size); this
-- column stores that per-size consumption (the XS…4XL grid from the live sheet).
-- =====================================================================

alter table public.sd_standard_cost_line add column if not exists consumption numeric;
