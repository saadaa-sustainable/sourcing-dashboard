-- =====================================================================
-- CMTP sub-item master (UAT fix #2).
--
-- Sub-items under each CMTP head (Labour, Cutting, Finishing, Packaging,
-- Product Trims, Brand Trims) were free-typed, so the same conceptual sub-item
-- got different spellings and cost data couldn't be aggregated by sub-item.
--
-- This makes the sub-item a managed, per-category master: a fixed-but-addable
-- lookup the UI dropdown reads from. The team can add a genuinely new sub-item
-- (recorded with who/when), but not by re-typing an existing one differently.
-- Mandatory heads and the per-line amount are unchanged; nothing here forces a
-- category (e.g. Trims) to be non-empty.
--
-- Seeded with the known operation lines already used as the CMTP sheet's
-- suggestions — the team confirms/extends the list from the UI, not in code.
-- Existing free-typed sd_cmtp_component.label values are intentionally NOT
-- auto-mapped here: reconcile them against this master as a manual cleanup step
-- (a fuzzy auto-merge could wrongly fuse two genuinely different sub-items).
-- =====================================================================

create table public.sd_cmtp_subitem (
  id          bigint generated always as identity primary key,
  category    text not null,               -- CMTP head key (Labour, Finishing, …)
  name        text not null,               -- standardized sub-item name
  is_active   boolean not null default true,
  created_by  text,
  created_at  timestamptz not null default now(),
  unique (category, name)
);

alter table public.sd_cmtp_subitem enable row level security;

-- Read for any @saadaa.in; add/edit for team + admin (they build the cost sheets).
create policy "saadaa read sd_cmtp_subitem" on public.sd_cmtp_subitem
  for select to authenticated using (public.sd_is_saadaa());
create policy "team manage sd_cmtp_subitem" on public.sd_cmtp_subitem
  for all to authenticated
  using (public.sd_can_write()) with check (public.sd_can_write());

grant select on public.sd_cmtp_subitem to authenticated;
grant insert, update, delete on public.sd_cmtp_subitem to authenticated;

-- Seed the known sub-items per head (from the live CMTP cost sheet).
insert into public.sd_cmtp_subitem (category, name) values
  ('Labour', 'Karigar'),
  ('Labour', 'Thekedar Comission'),
  ('Cutting', 'Cutting'),
  ('Finishing', 'Fabric QC'),
  ('Finishing', 'Iron'),
  ('Finishing', 'Thread Cutting'),
  ('Finishing', 'Final QC'),
  ('Finishing', 'Folding'),
  ('Packaging', 'Packing - poly bag'),
  ('Product Trims', 'Thread'),
  ('Product Trims', 'Fusing'),
  ('Product Trims', 'Button'),
  ('Product Trims', 'Kaaj'),
  ('Brand Trims', 'Brand Trims')
on conflict (category, name) do nothing;
