-- Item 1 (reverse Standard Cost sequencing): a Rules-Master toggle that makes an
-- APPROVED Standard Cost record a hard precondition for SUBMITTING a PO for that
-- product. Mahesh's correction — the cost must be proposed, reviewed and frozen
-- FIRST, then the PO issues against it; not typed ad hoc at PO time and backfilled.
--
-- Shipped DEFAULT OFF (value 0) on purpose: PO Approval is already live and the
-- standard-cost tables are still being populated ("team will fill later"). Turning
-- this on before approved standard costs exist would block every live PO submission.
-- Flip to 1 in Rules Master once standard costs are actually being approved first —
-- then it becomes the hard sequencing gate.  (1 = enforce, 0 = staged/off.)
insert into public.sd_analytics_rule (rule_key, value, label, description) values
  ('enforce_standard_cost_before_po', 0, 'Require approved Standard Cost before PO submit',
   'When 1, a PO cannot be submitted for approval unless an APPROVED Standard Cost record exists for its product (FG/NPD → sd_standard_cost, Material → sd_material_standard_cost). 0 = staged/off. Turn on once costs are being frozen before POs.')
on conflict (rule_key) do nothing;
