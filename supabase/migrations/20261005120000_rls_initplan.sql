-- Row-level security: evaluate the "who is asking" check once per query, not once per row.
--
-- Every policy called sd_is_saadaa() / sd_can_write() / sd_current_role() bare. Those are SQL
-- functions with their own search_path, so Postgres cannot inline them and ran them for EVERY
-- row read: a page of 1,000 GRN rows at offset 50,000 made 51,000 calls and took 828 ms.
-- Wrapped in (select …) the planner runs each once per query (an InitPlan): the same read takes
-- 25 ms. Who may read or write what is unchanged — only how often it is asked.
do $$
declare
  p record;
  q text;
  w text;
  wrap constant text := '(\m(sd_is_saadaa|sd_can_write|sd_current_role)\(\))';
begin
  for p in
    select schemaname, tablename, policyname, qual, with_check
      from pg_policies
     where schemaname = 'public'
       and (qual ~ 'sd_(is_saadaa|can_write|current_role)\(\)' or with_check ~ 'sd_(is_saadaa|can_write|current_role)\(\)')
  loop
    -- Skip anything already wrapped, so the migration can be re-run safely.
    q := case when p.qual is null or p.qual ~ 'SELECT (public\.)?sd_' then p.qual
              else regexp_replace(p.qual, wrap, '(select public.\2())', 'g') end;
    w := case when p.with_check is null or p.with_check ~ 'SELECT (public\.)?sd_' then p.with_check
              else regexp_replace(p.with_check, wrap, '(select public.\2())', 'g') end;
    if q is not null and w is not null then
      execute format('alter policy %I on %I.%I using (%s) with check (%s)', p.policyname, p.schemaname, p.tablename, q, w);
    elsif q is not null then
      execute format('alter policy %I on %I.%I using (%s)', p.policyname, p.schemaname, p.tablename, q);
    else
      execute format('alter policy %I on %I.%I with check (%s)', p.policyname, p.schemaname, p.tablename, w);
    end if;
  end loop;
end;
$$;

-- Indexes for the reads that were still scanning (from pg_stat_statements, 2026-10-05):
-- GRNs looked up by PO on the inward / receivable pages (1.5 s mean, no index on the column).
create index if not exists sd_ee_grn_po_ref_idx    on public.sd_ee_grn (po_ref_num, grn_detail_id);
create index if not exists sd_ee_grn_po_number_idx on public.sd_ee_grn (po_number, grn_detail_id);
-- Product page: all GRNs newest first (5–6 s mean).
create index if not exists sd_ee_grn_created_desc_idx on public.sd_ee_grn (grn_created_at desc nulls last, grn_detail_id desc);
-- Latest DOQ day.
create index if not exists sd_inventory_planning_date_idx on public.sd_inventory_planning (date_day desc);
