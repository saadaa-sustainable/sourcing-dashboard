-- Long-term storage, rule 4: freeze what the approver saw.
--
-- The review panels (stock, DOQ, cost vs standard, vendor load, TNA) are computed live, so a
-- year later they show today's numbers, not the ones the decision was made on. On approval
-- the whole review item is written here once and never recomputed.
alter table public.sd_po_approval
  add column if not exists review_snapshot    jsonb,
  add column if not exists review_snapshot_at timestamptz;

comment on column public.sd_po_approval.review_snapshot is
  'The review item (stock, cost, TNA, vendor figures, SKU lines) exactly as the approver saw it at approval. Written once by decideApproval.';
