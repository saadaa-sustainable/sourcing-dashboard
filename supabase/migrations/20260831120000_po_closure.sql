-- =====================================================================
-- PO Closure & Cutting Register — schema (spec §1).
--
-- Makes PO closure a gated, two-leg, SLA-tracked workflow, with a no-login
-- data-capture path (tokenized dynamic links → /fill/[token]).
--
-- Adaptations to the real schema (the spec assumed some infra that isn't here):
--   • po_ref_num is stored as plain TEXT, no FK. sd_po_dashboard is a VIEW (not a
--     table) and po_ref_num isn't unique in it, so a FK is impossible — this
--     matches the existing sd_po_approval convention.
--   • Completion is detected from sd_po_master_raw (the dashboard view is filtered
--     to po_status='Approved', so Completed POs never appear in it).
--   • BOM: sd_product_master gains bom_quantity / bom_uom (there was no BOM data);
--     the team fills these like the other masters.
--   • Anon reads go through a SECURITY DEFINER validator, never the raw tables.
-- =====================================================================

-- ---- Reconcile the name clash ----
-- An earlier migration (20260812130000) created a lightweight sd_po_closure — a
-- per-PO Yes/No closure decision (po_number PK), written by setPoClosure() and
-- read as the submission table's closureStatus. This rich workflow reuses the
-- sd_po_closure name, so rename the old stub → sd_po_closure_decision (it's empty;
-- no data lost) and repoint its code refs. Guarded so it's a one-time move.
do $$
begin
  if exists (select 1 from information_schema.columns
             where table_schema='public' and table_name='sd_po_closure' and column_name='po_number')
     and not exists (select 1 from information_schema.tables
             where table_schema='public' and table_name='sd_po_closure_decision') then
    alter table public.sd_po_closure rename to sd_po_closure_decision;
  end if;
end $$;

-- ---- BOM columns on the product master (team-filled) ----
alter table public.sd_product_master add column if not exists bom_quantity numeric;
alter table public.sd_product_master add column if not exists bom_uom      text;

-- ---- Tokenized, expiring, no-login data-capture links ----
create table if not exists public.sd_dynamic_links (
  id           bigserial primary key,
  token        text not null unique,        -- crypto-random (server-generated)
  link_type    text not null,               -- 'cutting_register' (extensible)
  po_ref_num   text not null,               -- plain text (see header); no FK to the view
  created_by   text not null,               -- email of the dashboard user who generated it
  created_at   timestamptz not null default now(),
  expires_at   timestamptz not null,
  is_active    boolean not null default true,
  submitted_at timestamptz,                 -- set once the form is submitted (link becomes single-use)
  sent_via     text[],                      -- e.g. {email} or {email,whatsapp}
  sent_to      text                         -- email/phone, audit only
);
create index if not exists sd_dynamic_links_token_idx on public.sd_dynamic_links (token);
create index if not exists sd_dynamic_links_po_idx    on public.sd_dynamic_links (po_ref_num);

-- ---- Actual fabric consumption per PO (dashboard or dynamic-link entry) ----
create table if not exists public.sd_cutting_register (
  id                     bigserial primary key,
  po_ref_num             text not null,      -- plain text; no FK to the view
  product_code           text,

  -- BOM snapshot, taken at record-creation time (spec §3 — reflects the standard
  -- as it was at cutting, not retroactively).
  bom_standard_qty       numeric,
  bom_uom                text,

  actual_consumption_qty numeric,
  cutting_date           date,
  remarks                text,

  -- provenance
  submitted_via          text not null default 'dashboard', -- 'dashboard' | 'dynamic_link'
  submitted_by_email     text,
  submitted_by_name      text,
  dynamic_link_id        bigint references public.sd_dynamic_links (id),

  created_at             timestamptz not null default now()
);
create index if not exists sd_cutting_register_po_idx on public.sd_cutting_register (po_ref_num);

-- ---- One row per PO once closure is initiated: both legs + SLA timestamps ----
create table if not exists public.sd_po_closure (
  id                    bigserial primary key,
  po_ref_num            text not null,       -- plain text; no FK to the view

  -- gating / SLA timestamps
  easycom_completed_at  timestamptz,         -- stamped when po_status_code=5 (raw)
  closure_initiated_at  timestamptz,         -- only allowed once easycom_completed_at is set
  initiated_by          text,

  -- sourcing leg
  sourcing_status       text not null default 'pending', -- pending | submitted
  sourcing_submitted_at timestamptz,
  sourcing_submitted_by text,
  cutting_register_ref  bigint references public.sd_cutting_register (id),
  surplus_fabric_qty    numeric,             -- computed (spec §4)
  surplus_fabric_value  numeric,             -- computed: surplus_qty × fabric standard cost

  -- finance leg
  finance_status        text not null default 'pending', -- pending | submitted
  finance_submitted_at  timestamptz,
  finance_submitted_by  text,
  challan_number        text,
  debit_note_number     text,
  debit_note_value      numeric,
  finance_remarks       text,

  -- final state
  closed_at             timestamptz,
  compliance_status     text,                -- computed: on_time | breached (spec §5)

  synced_at             timestamptz not null default now()
);
create unique index if not exists sd_po_closure_po_uidx on public.sd_po_closure (po_ref_num);
create index if not exists sd_po_closure_completed_idx  on public.sd_po_closure (easycom_completed_at);
create index if not exists sd_po_closure_compliance_idx on public.sd_po_closure (compliance_status);

-- ---- RLS: standard @saadaa.in read + write on all three (dashboard side) ----
-- Anon never touches these tables directly — the /fill route goes through the
-- SECURITY DEFINER validator/submit functions instead.
do $$
declare t text;
begin
  foreach t in array array['sd_dynamic_links', 'sd_cutting_register', 'sd_po_closure'] loop
    execute format('alter table public.%I enable row level security', t);
    execute format('grant select, insert, update, delete on public.%I to authenticated', t);
    if not exists (select 1 from pg_policies where schemaname='public' and tablename=t
                   and policyname = 'saadaa read ' || t) then
      execute format('create policy %I on public.%I for select to authenticated using (public.sd_is_saadaa())',
                     'saadaa read ' || t, t);
    end if;
    if not exists (select 1 from pg_policies where schemaname='public' and tablename=t
                   and policyname = 'sourcing write ' || t) then
      execute format('create policy %I on public.%I for all to authenticated using (public.sd_can_write()) with check (public.sd_can_write())',
                     'sourcing write ' || t, t);
    end if;
  end loop;
end $$;

grant usage, select on sequence public.sd_dynamic_links_id_seq    to authenticated;
grant usage, select on sequence public.sd_cutting_register_id_seq to authenticated;
grant usage, select on sequence public.sd_po_closure_id_seq       to authenticated;

-- ---- Token validation for the public /fill/[token] route ----
-- SECURITY DEFINER so the anon caller never reads sd_dynamic_links directly (no
-- enumeration): returns only whether the token is usable + the context the form
-- needs. Invalid / expired / inactive / already-submitted all collapse to
-- is_valid=false with no reason (no leakage). Product + BOM are resolved here so
-- the form can show the standard alongside the actual-consumption input (§3).
create or replace function public.sd_validate_dynamic_link(p_token text)
returns table (
  is_valid     boolean,
  link_type    text,
  po_ref_num   text,
  product_code text,
  bom_quantity numeric,
  bom_uom      text
)
language plpgsql
security definer
set search_path = ''
as $$
declare
  v public.sd_dynamic_links;
  v_pc text;
begin
  select * into v from public.sd_dynamic_links where token = p_token;

  if v.id is null
     or v.is_active is not true
     or v.submitted_at is not null
     or v.expires_at < now() then
    return query select false, null::text, null::text, null::text, null::numeric, null::text;
    return;
  end if;

  -- Product from the raw PO source (the dashboard view is Approved-only, so a
  -- Completed PO won't be there). One product per PO in this pipeline.
  select r.product_code into v_pc
    from public.sd_po_master_raw r
   where r.po_ref_num = v.po_ref_num
   limit 1;

  return query
    select true, v.link_type, v.po_ref_num, v_pc, pm.bom_quantity, pm.bom_uom
      from (select 1) _one
      left join public.sd_product_master pm on pm.product_code = v_pc;
end;
$$;

-- The public route needs to call this without a login.
grant execute on function public.sd_validate_dynamic_link(text) to anon, authenticated;
