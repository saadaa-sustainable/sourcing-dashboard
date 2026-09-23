-- Deleting a raised PO request now follows the approval path: the raiser asks, an
-- admin decides, and only an approved request actually marks the PO deleted.
--
-- One row per ask, so the queue, the audit log and the decision all work the way every
-- other approval does. The PO row itself still carries deleted_at / deleted_by /
-- delete_reason (migration 20260923160000) — those are stamped when the ask is approved.

create table if not exists public.sd_po_delete_request (
  id            bigint generated always as identity primary key,
  po_id         bigint not null references public.sd_po_approval(id) on delete cascade,
  -- Snapshot of the PO as it stood when deletion was asked for: the approval card has to
  -- read on its own, and the PO can move on (or be edited) before the decision.
  request_id    text not null,
  product_code  text,
  vendor_code   text,
  vendor_name   text,
  po_qty        numeric not null default 0,
  po_status     sd_status not null,
  reason        text not null,

  status        sd_status not null default 'pending_l2',
  requested_by  text not null,
  requested_at  timestamptz not null default now(),
  approved_by   text,
  approved_at   timestamptz,
  rejection_notes text,
  -- Written by the shared decideApproval path when a decision is "send back".
  rework_notes  text,
  reworked_by   text,
  reworked_at   timestamptz,
  edited_before_approval boolean not null default false
);

comment on table public.sd_po_delete_request is
  'A request to delete a raised PO request. Always admin-decided; approval is what stamps sd_po_approval.deleted_at.';

-- At most one undecided ask per PO — a second one would put two cards in the queue for
-- the same thing.
create unique index if not exists sd_po_delete_request_open_uidx
  on public.sd_po_delete_request (po_id)
  where status in ('submitted', 'pending_l2');

create index if not exists sd_po_delete_request_status_idx
  on public.sd_po_delete_request (status);
create index if not exists sd_po_delete_request_po_idx
  on public.sd_po_delete_request (po_id, id desc);

-- Same access shape as every other request table.
alter table public.sd_po_delete_request enable row level security;

drop policy if exists "saadaa read sd_po_delete_request" on public.sd_po_delete_request;
create policy "saadaa read sd_po_delete_request"
  on public.sd_po_delete_request for select using (sd_is_saadaa());

drop policy if exists "sourcing write sd_po_delete_request" on public.sd_po_delete_request;
create policy "sourcing write sd_po_delete_request"
  on public.sd_po_delete_request for all using (sd_can_write()) with check (sd_can_write());
