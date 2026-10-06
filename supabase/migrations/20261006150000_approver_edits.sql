-- Edit & approve: wherever an approval is required, the approver may change the submitted values
-- and approve in one step. Every changed value is recorded here (old -> new), and the record
-- (and line, where lines are edited) is flagged so its status reads "Approved with approver's edits".

create table if not exists public.sd_approval_edit (
  id          bigserial primary key,
  entity_type text not null,          -- ApprovalEntity (buying_plan, po_approval, inward_plan, ...)
  entity_id   text not null,          -- record id; plan month for inward_plan; 'batch' for receivable_plan
  row_ref     text not null,          -- which row was edited: 'header', a line id, a row_key
  row_label   text,                   -- human label of that row at the time (product, PO, size...)
  field       text not null,
  field_label text,
  old_value   text,
  new_value   text,
  edited_by   text not null,
  edited_at   timestamptz not null default now()
);
create index if not exists sd_approval_edit_entity_idx on public.sd_approval_edit (entity_type, entity_id, edited_at desc);

alter table public.sd_approval_edit enable row level security;
drop policy if exists sd_approval_edit_read on public.sd_approval_edit;
create policy sd_approval_edit_read on public.sd_approval_edit for select to authenticated
  using ((select public.sd_is_saadaa()));
drop policy if exists sd_approval_edit_insert on public.sd_approval_edit;
create policy sd_approval_edit_insert on public.sd_approval_edit for insert to authenticated
  with check ((select public.sd_can_write()));

-- "Edited by the approver" flags: on every record that goes through approval, and on the
-- line tables whose lines the approver can change one by one.
alter table public.sd_buying_plan               add column if not exists approver_edited boolean not null default false;
alter table public.sd_buying_plan_line          add column if not exists approver_edited boolean not null default false;
alter table public.sd_po_approval               add column if not exists approver_edited boolean not null default false;
alter table public.sd_po_approval_line          add column if not exists approver_edited boolean not null default false;
alter table public.sd_po_amendment              add column if not exists approver_edited boolean not null default false;
alter table public.sd_discontinue_request       add column if not exists approver_edited boolean not null default false;
alter table public.sd_vendor_deboarding_request add column if not exists approver_edited boolean not null default false;
alter table public.sd_inward_plan_entry         add column if not exists approver_edited boolean not null default false;
alter table public.sd_receivable_input          add column if not exists approver_edited boolean not null default false;
