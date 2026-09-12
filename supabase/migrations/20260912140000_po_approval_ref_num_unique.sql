-- PO Approval: PO reference numbers must be unique.
--
-- No two sd_po_approval rows may carry the same po_ref_num. Enforced at the DB
-- with a PARTIAL unique index so that NULL / blank refs (drafts that haven't been
-- given a reference yet) are exempt — only real, non-empty references are unique.
-- The app layer (savePoApproval) also checks and returns a friendly message; this
-- index is the hard guarantee against races and any path that bypasses the action.
--
-- Verified no existing duplicates before creating (would otherwise fail to build).

create unique index if not exists sd_po_approval_ref_num_uidx
  on public.sd_po_approval (po_ref_num)
  where po_ref_num is not null and btrim(po_ref_num) <> '';
