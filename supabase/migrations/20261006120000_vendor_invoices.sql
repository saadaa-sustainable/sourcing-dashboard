-- Vendor Invoices - Accounts: the Google Form moves onto the dashboard.
--
-- Vendors share the soft copy of an Invoice / Debit Note / Credit Note through ONE open,
-- no-login page (/vendor-invoice), exactly as they did with the form. The page writes
-- through a server action holding the service-role key, so anon gets no grant here at
-- all: not on the table, not on the bucket. SAADAA users read the log on /vendor-invoices.
--
-- Columns follow the form question for question. The form branches:
--   association = Fabrication / Transportation / Trims  -> vendor code + PO type asked
--   association = Fabric Dyeing / Fabric Supply         -> those two skipped
--   document type = INVOICE     -> invoice no, date, total qty, value, GRN no, challan no
--   document type = DEBIT/CREDIT NOTE -> note date + reference document number
-- Every branch ends with one PDF, kept in the private vendor-invoices bucket.

create table if not exists public.sd_vendor_invoice (
  id                        bigint generated always as identity primary key,
  created_at                timestamptz not null default now(),
  email                     text not null,
  po_ref_num                text not null,
  association               text not null check (association in (
                              'Fabrication Partner', 'Fabric Dyeing Partner',
                              'Fabric (Greige / Dyed) Supply Partner',
                              'Transportation Partner', 'Trims Partner')),
  vendor_code               text,
  po_type                   text,
  document_type             text not null check (document_type in ('INVOICE', 'DEBIT NOTE', 'CREDIT NOTE')),
  -- INVOICE
  invoice_number            text,
  invoice_date              date,
  invoice_total_qty         numeric,
  invoice_value             numeric,
  grn_number                text,
  reference_challan_number  text,
  -- DEBIT NOTE / CREDIT NOTE
  note_date                 date,
  reference_document_number text,
  -- the PDF
  file_path                 text not null,
  file_name                 text,
  -- who keyed it: 'public_link' (vendor, no login) or a signed-in SAADAA user
  submitted_via             text not null default 'public_link',
  submitted_by_email        text,
  constraint sd_vendor_invoice_invoice_fields check (
    document_type <> 'INVOICE' or (
      invoice_number is not null and invoice_date is not null and invoice_total_qty is not null
      and invoice_value is not null and reference_challan_number is not null)),
  constraint sd_vendor_invoice_note_fields check (
    document_type = 'INVOICE' or (note_date is not null and reference_document_number is not null))
);

create index if not exists sd_vendor_invoice_created_idx on public.sd_vendor_invoice (created_at desc, id desc);
create index if not exists sd_vendor_invoice_po_idx      on public.sd_vendor_invoice (po_ref_num);
create index if not exists sd_vendor_invoice_vendor_idx  on public.sd_vendor_invoice (vendor_code);

alter table public.sd_vendor_invoice enable row level security;

drop policy if exists sd_vendor_invoice_read on public.sd_vendor_invoice;
create policy sd_vendor_invoice_read on public.sd_vendor_invoice
  for select to authenticated using ((select public.sd_is_saadaa()));

-- Writes come only from the server (service role). An admin can remove a junk entry
-- through the dashboard, which also goes through the server.
revoke all on public.sd_vendor_invoice from anon;
revoke insert, update, delete, truncate on public.sd_vendor_invoice from authenticated;
grant select on public.sd_vendor_invoice to authenticated;

-- Private bucket: PDFs only, 10 MB each. Files are opened through short-lived signed URLs.
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('vendor-invoices', 'vendor-invoices', false, 10485760, array['application/pdf'])
on conflict (id) do update
  set public = false, file_size_limit = excluded.file_size_limit, allowed_mime_types = excluded.allowed_mime_types;

-- Audit trail, same as every other table typed on the dashboard (no-op if absent).
do $$
begin
  if to_regprocedure('public.sd_audit_trigger()') is not null then
    drop trigger if exists sd_audit on public.sd_vendor_invoice;
    create trigger sd_audit after insert or update or delete on public.sd_vendor_invoice
      for each row execute function public.sd_audit_trigger('id');
  end if;
end $$;

-- One entry per uploaded PDF (a double-click must not file it twice).
create unique index if not exists sd_vendor_invoice_file_uidx on public.sd_vendor_invoice (file_path);
