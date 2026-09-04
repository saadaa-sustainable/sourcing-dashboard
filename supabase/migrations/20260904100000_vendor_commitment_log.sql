-- =====================================================================
-- Vendor delivery-commitment log (Vendor Commitment/OTIF spec item 1).
--
-- When a vendor commits a delivery date and later revises it, the revision is
-- logged as its OWN event rather than overwriting the original — so a vendor who
-- revises often reads differently from one who commits once and holds it. This
-- append-only history is the source for OTIF's On-Time variable (item 2) and the
-- Budget-vs-Actual on-time-commitment tracking (earlier spec's item 6).
--
-- Populated as a side-effect of the existing committed-date flow (PO issuance +
-- TNA confirmation), not a separate manual screen. po_ref_num is stored as text
-- (sd_po_dashboard is a synced mirror, so no hard FK); actual_delivery_date /
-- delay_days are reserved for a delivery-time fill (OTIF computes on-time by
-- joining GRN actuals at read for now).
-- =====================================================================

create table public.sd_vendor_commitment_log (
  id                   bigint generated always as identity primary key,
  po_ref_num           text not null,
  vendor_code          text,
  committed_date       date not null,      -- original committed date (kept on every event)
  committed_at         timestamptz,        -- when the original commitment was logged
  revised_date         date,               -- set on a revision event (null on the initial)
  revised_at           timestamptz,
  actual_delivery_date date,               -- reserved: filled once delivery actually happens
  delay_days           integer,            -- reserved: actual − most-recent committed/revised
  logged_by            text,
  created_at           timestamptz not null default now()
);
create index sd_vendor_commitment_log_po_idx on public.sd_vendor_commitment_log (po_ref_num);
create index sd_vendor_commitment_log_vendor_idx on public.sd_vendor_commitment_log (vendor_code);

alter table public.sd_vendor_commitment_log enable row level security;
create policy "saadaa read sd_vendor_commitment_log" on public.sd_vendor_commitment_log
  for select to authenticated using (public.sd_is_saadaa());
create policy "team write sd_vendor_commitment_log" on public.sd_vendor_commitment_log
  for all to authenticated
  using (public.sd_can_write()) with check (public.sd_can_write());

grant select on public.sd_vendor_commitment_log to authenticated;
grant insert, update, delete on public.sd_vendor_commitment_log to authenticated;
