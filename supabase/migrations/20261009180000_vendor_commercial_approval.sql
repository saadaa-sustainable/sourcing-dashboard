-- Vendor Commercial Approval (2026-10-09): the team's Google Form "COMMERCIAL APPROVAL FORM"
-- brought onto the dashboard as a request that goes through the shared approval queue, the
-- same way Vendor De-Boarding did. Same approval columns as sd_vendor_deboarding_request, so
-- decideApproval / ApprovalBar / Edit & approve / the log work unchanged.
--
-- The form, section by section:
--   Business type:  garment (Job / E-FOB / FOB manufacturer) | fabric (greige supplier / dyer)
--   Firm name, vendor code, PO number(s), type of request:
--     hold_waiver     — waiver for goods / fabric held by SAADAA: hold qty, days asked, ready date, reason
--     cost_increment  — commercial approval / cost increment: reason (list per business type, or other),
--                       increment amount asked, remarks
--     cash_discount   — owner name + contact, invoice no / date / amount, RG pending with vendor, invoice copy
--     dn_removal      — debit note number, reason, proof
--     credit_note     — amount, reason, proof
-- Files (invoice copy, proof) go to the private bucket `commercial-approvals` through
-- server-issued signed upload URLs; `attachments` holds [{path, name, size}].

create table if not exists public.sd_vendor_commercial_request (
  id                bigserial primary key,
  business_type     text not null check (business_type in ('garment', 'fabric')),
  vendor_code       text not null,
  vendor_name       text,
  po_numbers        text not null,
  request_type      text not null check (request_type in ('hold_waiver', 'cost_increment', 'cash_discount', 'dn_removal', 'credit_note')),
  -- hold_waiver
  hold_qty          numeric check (hold_qty is null or hold_qty >= 0),
  hold_days         integer check (hold_days is null or hold_days >= 0),
  ready_date        date,
  hold_reason       text,
  -- cost_increment
  cost_reason       text,
  cost_reason_other text,
  increment_amount  numeric check (increment_amount is null or increment_amount >= 0),
  -- cash_discount
  owner_name        text,
  owner_contact     text,
  invoice_number    text,
  invoice_date      date,
  invoice_amount    numeric check (invoice_amount is null or invoice_amount >= 0),
  rg_pending        text,
  -- dn_removal
  debit_note_number text,
  -- credit_note
  credit_amount     numeric check (credit_amount is null or credit_amount >= 0),
  -- The explanation every request carries (cost remarks / DN reason / credit-note reason / hold reason).
  remarks           text not null,
  attachments       jsonb not null default '[]'::jsonb,
  -- Approval ladder, identical to the other request tables.
  status            public.sd_status not null default 'draft',
  requested_by      text,
  requested_at      timestamptz,
  approved_by       text,
  approved_at       timestamptz,
  rejection_notes   text,
  rework_notes      text,
  reworked_by       text,
  reworked_at       timestamptz,
  edited_before_approval boolean not null default false,
  approver_edited   boolean not null default false
);

create index if not exists sd_vendor_commercial_vendor_idx on public.sd_vendor_commercial_request (upper(vendor_code));
create index if not exists sd_vendor_commercial_status_idx on public.sd_vendor_commercial_request (status);

alter table public.sd_vendor_commercial_request enable row level security;
drop policy if exists "saadaa read sd_vendor_commercial_request" on public.sd_vendor_commercial_request;
create policy "saadaa read sd_vendor_commercial_request" on public.sd_vendor_commercial_request
  for select to authenticated using ((select public.sd_is_saadaa()));
drop policy if exists "sourcing write sd_vendor_commercial_request" on public.sd_vendor_commercial_request;
create policy "sourcing write sd_vendor_commercial_request" on public.sd_vendor_commercial_request
  for all to authenticated using ((select public.sd_can_write())) with check ((select public.sd_can_write()));
grant select, insert, update, delete on public.sd_vendor_commercial_request to authenticated;
grant usage on sequence public.sd_vendor_commercial_request_id_seq to authenticated;

-- Private bucket for invoice copies and proof (25 MB a file).
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('commercial-approvals', 'commercial-approvals', false, 26214400, null)
on conflict (id) do update set public = false, file_size_limit = excluded.file_size_limit;

do $$
begin
  if to_regprocedure('public.sd_audit_trigger()') is not null then
    drop trigger if exists sd_audit on public.sd_vendor_commercial_request;
    create trigger sd_audit after insert or update or delete on public.sd_vendor_commercial_request
      for each row execute function public.sd_audit_trigger('id');
  end if;
end $$;
