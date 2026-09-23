-- A raised PO request can be deleted by the person who raised it, with a reason,
-- until it is approved. The row is NEVER removed: it is marked deleted and drops
-- out of every live list, so admin can still see what was deleted, by whom and why.
--
-- No new sd_status value: 'deleted' is not a state a standard cost or a plan can be
-- in, and sd_status is shared across all of them. Deletion is a property of the row.

alter table public.sd_po_approval
  add column if not exists deleted_at    timestamptz,
  add column if not exists deleted_by    text,
  add column if not exists delete_reason text;

comment on column public.sd_po_approval.deleted_at is
  'Set when the request was deleted by its creator (or an admin). Live lists filter on deleted_at is null.';
comment on column public.sd_po_approval.deleted_by is
  'Email of whoever deleted it — the creator in the normal case, an admin otherwise.';
comment on column public.sd_po_approval.delete_reason is
  'Mandatory reason given at deletion. Shown in the admin deleted-requests log.';

-- Live reads all filter `deleted_at is null`; deleted ones are a short list read by date.
create index if not exists sd_po_approval_deleted_at_idx
  on public.sd_po_approval (deleted_at desc)
  where deleted_at is not null;
