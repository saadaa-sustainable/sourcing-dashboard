-- PO Approval: TNA critical-path dates become an approver-confirmed, locked field.
-- The routed approver (team for FG ≤5,000; admin for >5,000 / NPD / MAT) reviews and
-- confirms the dates via confirmTna; decideApproval hard-blocks the cost decision until
-- tna_confirmed is true, so a nonsensical delivery window can't be cost-approved unchecked.
alter table public.sd_po_approval
  add column if not exists tna_confirmed boolean not null default false,
  add column if not exists tna_confirmed_by text,
  add column if not exists tna_confirmed_at timestamptz;
