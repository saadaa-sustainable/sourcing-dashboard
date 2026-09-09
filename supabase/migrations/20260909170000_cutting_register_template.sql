-- Cutting Register redesign to match the team's template (fabric SKU -> PO -> item flow).
-- Adds the columns that line up 1:1 with the warehouse table po_qty_cutting_register, so
-- the BigQuery push no longer has to leave fields null.

alter table public.sd_cutting_register
  add column if not exists vendor_code                    text,
  add column if not exists po_number                      text,
  add column if not exists fabric_sku_code                text,
  add column if not exists item_code                      text,
  add column if not exists cutting_qty                    numeric,
  add column if not exists avg_fabric_consumption_approved numeric,
  add column if not exists width_of_fabric                text,
  add column if not exists cutting_approval_sheet         text,   -- storage path of the signed sheet image
  add column if not exists fabric_consumed                numeric;

-- Private bucket holding the "Saadaa Sign Mandatory" cutting-approval images.
insert into storage.buckets (id, name, public)
values ('cutting-approvals', 'cutting-approvals', false)
on conflict (id) do nothing;

-- Writers upload; saadaa users can read (viewed via signed URLs from the dashboard).
drop policy if exists "cutting_approvals_insert" on storage.objects;
create policy "cutting_approvals_insert" on storage.objects
  for insert to authenticated
  with check (bucket_id = 'cutting-approvals' and public.sd_can_write());

drop policy if exists "cutting_approvals_read" on storage.objects;
create policy "cutting_approvals_read" on storage.objects
  for select to authenticated
  using (bucket_id = 'cutting-approvals' and public.sd_is_saadaa());
