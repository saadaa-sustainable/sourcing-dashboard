-- =====================================================================
-- Cost Approval as its own process (PR1) — the negotiation lifecycle.
--
-- Cost is negotiated, not just approved:
--   team proposes  →  Mahesh sets a target cost  →  team enters the actual
--   vendor rate  →  Mahesh signs off  →  that becomes the Standard Cost.
--
-- The stage lives in its own `neg_stage` column (the shared sd_status enum is
-- left alone). The operative rates stay job_cost/fob_cost/efob_cost (the "actual
-- rate"); sign-off flips status to 'approved' so the Buying Plan keeps valuing
-- from it. Applies to BOTH the FG and material cost sheets.
-- =====================================================================

do $$
declare t text;
begin
  foreach t in array array['sd_standard_cost', 'sd_material_standard_cost'] loop
    execute format('alter table public.%I add column if not exists neg_stage text', t);
    execute format('alter table public.%I add column if not exists proposed_cost numeric', t);
    execute format('alter table public.%I add column if not exists target_cost numeric', t);
    execute format('alter table public.%I add column if not exists negotiation_notes text', t);
    execute format(
      'alter table public.%I drop constraint if exists %I',
      t, t || '_neg_stage_chk'
    );
    execute format(
      'alter table public.%I add constraint %I check (neg_stage is null or neg_stage in
         (''proposed'',''target_set'',''rate_submitted'',''signed_off'',''renegotiate'',''rejected''))',
      t, t || '_neg_stage_chk'
    );
  end loop;
end $$;
