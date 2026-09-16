-- PO Approval <-> Buying Plan relationship (spec item 6).
-- The two are NOT gated on each other: a PO for a product outside the plan is an ad-hoc
-- purchase - allowed, not blocked. The only link is DISPLAY: at submission the PO records
-- whether its product was in the linked month's approved buying plan (and the approved
-- quantity at that moment), plus an optional reason when it is outside the plan, so the
-- approver sees "in plan" / "ad-hoc - urgent replenishment" and approves either way.
alter table public.sd_po_approval
  add column if not exists in_buying_plan     boolean,   -- null = not yet checked (draft)
  add column if not exists plan_qty_at_submit numeric,   -- approved plan qty for the product at submission
  add column if not exists ad_hoc_reason      text;      -- e.g. urgent replenishment, stock ran out
