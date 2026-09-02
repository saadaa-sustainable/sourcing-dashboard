-- =====================================================================
-- Product Class (ABC/D) thresholds — Rules Master entries.
--
-- Class is computed from the SKU's Inventory-Planning DOQ (IPDOQ):
--   IPDOQ >  A-threshold (10) → A
--   IPDOQ >= B-threshold (7)  → B
--   IPDOQ >= C-threshold (3)  → C
--   else                      → D
-- NPD-family states (NPD, NPD - Not Launched Yet, SKU Create But Not
-- Launch) are not classified — their COM suffix is the literal "NPD",
-- matching the curated sheet (no meaningful sales history to class on).
--
-- COM STATUS (the DOQ Dashboard detail breakdown) = "<state>-<class>".
-- =====================================================================

insert into public.sd_analytics_rule (rule_key, value, label, description) values
  ('product_class_a_above', 10, 'Product Class — A above DOQ',
   'A SKU is class A when its IPDOQ is strictly above this daily rate.'),
  ('product_class_b_min', 7, 'Product Class — B from DOQ',
   'Class B from this IPDOQ (up to the A threshold).'),
  ('product_class_c_min', 3, 'Product Class — C from DOQ',
   'Class C from this IPDOQ (up to the B threshold); below it is class D.')
on conflict (rule_key) do nothing;
