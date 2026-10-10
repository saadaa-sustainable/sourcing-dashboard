-- Standard Cost document attachments (2026-10-09).
--
-- A Finished Goods standard cost carries its CAD plans (markers) and the RFP sheet link.
-- CAD plans sit in a library grouped under four primary headers:
--   single_piece    — Single piece
--   full_layer_58   — Full layer, single size, per width · 58" (each width separate)
--   full_layer_56   — Full layer, single size, per width · 56"
--   standard_ratio  — Standard ratio
--   ratio_1_1       — 1:1 size ratio
-- Each file is added with a remark. No approval on the documents (user, 2026-10-09).
-- The RFP sheet link is the cost's existing sd_standard_cost.rfp_link.

create table if not exists public.sd_cost_document (
  id bigserial primary key,
  product_code text not null,
  doc_group text not null check (doc_group in ('single_piece', 'full_layer_58', 'full_layer_56', 'standard_ratio', 'ratio_1_1')),
  file_path text not null,
  file_name text not null,
  file_size bigint,
  remark text,
  created_by text,
  created_at timestamptz not null default now()
);
create index if not exists sd_cost_document_product_idx on public.sd_cost_document (product_code);
-- One row per uploaded file (a double-click must not add it twice).
create unique index if not exists sd_cost_document_file_uidx on public.sd_cost_document (file_path);

alter table public.sd_cost_document enable row level security;
drop policy if exists "saadaa read sd_cost_document" on public.sd_cost_document;
create policy "saadaa read sd_cost_document" on public.sd_cost_document
  for select to authenticated using ((select public.sd_is_saadaa()));
drop policy if exists "sourcing write sd_cost_document" on public.sd_cost_document;
create policy "sourcing write sd_cost_document" on public.sd_cost_document
  for all to authenticated using ((select public.sd_can_write())) with check ((select public.sd_can_write()));
grant select, insert, update, delete on public.sd_cost_document to authenticated;
grant usage on sequence public.sd_cost_document_id_seq to authenticated;

-- Private bucket; files reach it through server-issued signed upload URLs and are opened
-- through short-lived signed URLs, so no storage.objects policies are needed.
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('cost-documents', 'cost-documents', false, 26214400, null)
on conflict (id) do update set public = false, file_size_limit = excluded.file_size_limit;

-- Audit trail, same as every other table typed on the dashboard (no-op if absent).
do $$
begin
  if to_regprocedure('public.sd_audit_trigger()') is not null then
    drop trigger if exists sd_audit on public.sd_cost_document;
    create trigger sd_audit after insert or update or delete on public.sd_cost_document
      for each row execute function public.sd_audit_trigger('id');
  end if;
end $$;
