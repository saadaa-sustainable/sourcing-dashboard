-- Private PO-specific CAD attachments, separate from approved Standard Cost files.
create table public.sd_po_cad_document (
 id bigint generated always as identity primary key,
 po_id bigint not null references public.sd_po_approval(id),
 file_path text not null unique,
 file_name text not null check(length(file_name) between 1 and 255 and file_name ~* '\.pdf$'),
 file_size bigint not null check(file_size>0 and file_size<=26214400),
 doc_group text not null check(doc_group in ('single_piece','full_layer','standard_ratio','ratio_1_1')),
 width text,
 remark text check(remark is null or length(remark)<=2000),
 created_by text not null,
 created_at timestamptz not null default now(),
 uploaded_at timestamptz,
 removed_at timestamptz,
 removed_by text,
 check((removed_at is null) = (removed_by is null)),
 check(file_path ~ ('^'||po_id::text||'/[0-9a-f-]{36}\.pdf$')),
 check(doc_group<>'full_layer' or (width is not null and btrim(width)<>''))
);
create index sd_po_cad_document_parent_idx on public.sd_po_cad_document(po_id,id);
alter table public.sd_po_cad_document enable row level security;
revoke all privileges on public.sd_po_cad_document from public,anon,authenticated;
revoke all privileges on sequence public.sd_po_cad_document_id_seq from public,anon,authenticated;
grant select on public.sd_po_cad_document to authenticated;
grant all privileges on public.sd_po_cad_document to service_role;
grant usage,select on sequence public.sd_po_cad_document_id_seq to service_role;
create policy "saadaa read PO CAD documents" on public.sd_po_cad_document for select to authenticated using(public.sd_is_saadaa());
-- Mutations run only through authenticated server actions using service-role storage.
-- Locking the parent makes concurrent approval and attachment edits serialize.
create function public.sd_guard_po_cad_document() returns trigger language plpgsql security invoker set search_path=public,pg_temp as $$
declare p public.sd_po_approval%rowtype;
begin
 select * into p from public.sd_po_approval where id=new.po_id for update;
 if not found then raise exception 'PO not found.'; end if;
 if p.status='approved' then raise exception 'Approved PO CAD plans are locked.'; end if;
 if p.status='rework' and p.rework_sections is not null and not ('cost'=any(p.rework_sections)) then raise exception 'Cost is not selected for rework.'; end if;
 if tg_op='UPDATE' and (new.po_id,new.file_path,new.file_name,new.file_size,new.doc_group,new.width,new.remark,new.created_by,new.created_at) is distinct from (old.po_id,old.file_path,old.file_name,old.file_size,old.doc_group,old.width,old.remark,old.created_by,old.created_at) then raise exception 'CAD upload metadata cannot be reassigned.'; end if;
 return new;
end $$;
revoke all on function public.sd_guard_po_cad_document() from public,anon,authenticated;
create trigger sd_guard_po_cad_document before insert or update on public.sd_po_cad_document for each row execute function public.sd_guard_po_cad_document();
insert into storage.buckets(id,name,public,file_size_limit,allowed_mime_types)
values('po-cad-plans','po-cad-plans',false,26214400,array['application/pdf']);
-- No direct storage object policies: upload/read access uses scoped signed URLs.
