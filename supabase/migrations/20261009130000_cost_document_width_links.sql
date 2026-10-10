-- Standard Cost → Documents: "Full layer · single size per width" holds any number of
-- width + link entries (user, 2026-10-09: "user will type/select the width and share the link,
-- this can have multiple widths and links"). The fixed 58" / 56" slots go away.
--
--   doc_group 'full_layer' — width (text, e.g. '58') + link_url; no file.
--   The other groups (single_piece, standard_ratio, ratio_1_1) stay file uploads.
-- Rows already filed under full_layer_58 / full_layer_56 move to 'full_layer' with that width
-- and keep their file (they still open).

alter table public.sd_cost_document add column if not exists width text;
alter table public.sd_cost_document add column if not exists link_url text;
alter table public.sd_cost_document alter column file_path drop not null;
alter table public.sd_cost_document alter column file_name drop not null;

alter table public.sd_cost_document drop constraint if exists sd_cost_document_doc_group_check;

update public.sd_cost_document set doc_group = 'full_layer', width = '58' where doc_group = 'full_layer_58';
update public.sd_cost_document set doc_group = 'full_layer', width = '56' where doc_group = 'full_layer_56';

alter table public.sd_cost_document add constraint sd_cost_document_doc_group_check
  check (doc_group in ('single_piece', 'full_layer', 'standard_ratio', 'ratio_1_1'));

-- Every entry is either an uploaded file or a shared link.
alter table public.sd_cost_document drop constraint if exists sd_cost_document_file_or_link;
alter table public.sd_cost_document add constraint sd_cost_document_file_or_link
  check (file_path is not null or link_url is not null);
