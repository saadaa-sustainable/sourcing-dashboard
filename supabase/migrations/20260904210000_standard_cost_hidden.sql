-- Soft-delete (hide) for Standard Cost. A user can "delete" a product from the
-- Standard Cost screen: it stops appearing in the worklist, but NOTHING is removed —
-- the cost row, its lines, CMTP, and rate history all stay exactly as they were.
-- Searching + adding the same code again just un-hides it, fully intact. So this is a
-- visibility flag, never a data delete.
alter table public.sd_standard_cost          add column if not exists hidden boolean not null default false;
alter table public.sd_material_standard_cost add column if not exists hidden boolean not null default false;
