-- Long-term storage, rule 3: one append-only audit table for everything typed on the dashboard.
--
-- Every insert, update and delete on an authored table writes the row before and after the
-- change, with who and when. A hard delete is no longer a loss: the full old row stays here, so
-- this doubles as the soft-delete safety net without touching every query in the app.
-- Synced tables (sd_ee_*, sd_po_master_raw, inventory, logs) are deliberately left out: their
-- history lives in the source system.
create table if not exists public.sd_audit_log (
  id          bigserial primary key,
  table_name  text        not null,
  row_pk      text        not null,
  op          text        not null check (op in ('INSERT', 'UPDATE', 'DELETE')),
  changed_at  timestamptz not null default now(),
  changed_by  text,
  before      jsonb,
  after       jsonb
);

create index if not exists sd_audit_log_row_idx on public.sd_audit_log (table_name, row_pk, changed_at desc);
create index if not exists sd_audit_log_at_idx  on public.sd_audit_log (changed_at desc);

alter table public.sd_audit_log enable row level security;
drop policy if exists sd_audit_log_read on public.sd_audit_log;
create policy sd_audit_log_read on public.sd_audit_log for select to authenticated using (public.sd_is_saadaa());
-- Append-only: no one edits or removes history through the API; only the trigger writes.
revoke insert, update, delete, truncate on public.sd_audit_log from anon, authenticated;

-- TG_ARGV holds the primary-key column names, so the row can be found again later.
create or replace function public.sd_audit_trigger()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  old_j jsonb := case when tg_op in ('UPDATE', 'DELETE') then to_jsonb(old) end;
  new_j jsonb := case when tg_op in ('INSERT', 'UPDATE') then to_jsonb(new) end;
  src   jsonb := coalesce(new_j, old_j);
  pk    text  := '';
  who   text;
  i     int;
begin
  -- A re-save that changes nothing (sync upserts, double clicks) is not history. Bookkeeping
  -- columns that move on every save or sync do not count as a change.
  if tg_op = 'UPDATE'
     and old_j - array['synced_at', 'sync_token', 'updated_at', 'last_seen_at']
       = new_j - array['synced_at', 'sync_token', 'updated_at', 'last_seen_at'] then
    return null;
  end if;

  for i in 0 .. tg_nargs - 1 loop
    pk := pk || case when i > 0 then '|' else '' end || coalesce(src ->> tg_argv[i], '');
  end loop;

  who := coalesce(
    nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'email',
    nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'role',
    current_user
  );

  insert into public.sd_audit_log (table_name, row_pk, op, changed_by, before, after)
  values (tg_table_name, pk, tg_op, who, old_j, new_j);
  return null;
end;
$$;

revoke all on function public.sd_audit_trigger() from public, anon, authenticated;

-- Attach to every authored table. [table, pk columns...]
do $$
declare
  spec text[];
  specs text[][] := array[
    array['sd_po_approval', 'id', null],
    array['sd_po_approval_line', 'id', null],
    array['sd_po_amendment', 'id', null],
    array['sd_po_delete_request', 'id', null],
    array['sd_po_closure', 'id', null],
    array['sd_po_closure_decision', 'po_number', null],
    array['sd_buying_plan', 'id', null],
    array['sd_buying_plan_line', 'id', null],
    array['sd_standard_cost', 'id', null],
    array['sd_standard_cost_line', 'id', null],
    array['sd_standard_cost_extra_fabric', 'id', null],
    array['sd_standard_cost_rate_history', 'id', null],
    array['sd_material_standard_cost', 'id', null],
    array['sd_material_standard_cost_rate_history', 'id', null],
    array['sd_cmtp_component', 'id', null],
    array['sd_cmtp_subitem', 'id', null],
    array['sd_cmtp_revision', 'id', null],
    array['sd_fabric_rate_submission', 'id', null],
    array['sd_efob_fabric_cost', 'month', 'fabric_code'],
    array['sd_fabric_cost_base', 'fabric_code', null],
    array['sd_inward_plan_entry', 'id', null],
    array['sd_receivable_input', 'row_key', null],
    array['sd_cutting_register', 'id', null],
    array['sd_manual_adjustment_entry', 'id', null],
    array['sd_vendor_capacity_log', 'id', null],
    array['sd_vendor_commitment_log', 'id', null],
    array['sd_vendor_product_capacity_allocation', 'id', null],
    array['sd_vendor_payment_terms', 'vendor_code', null],
    array['sd_vendor_deboarding_request', 'id', null],
    array['sd_discontinue_request', 'id', null],
    array['sd_npd_budget', 'plan_month', null],
    array['sd_temp_product', 'temp_code', null],
    array['sd_product_master', 'product_code', null],
    array['sd_material_master', 'material_code', null],
    array['sd_fabric_master', 'fabric_code', null],
    array['sd_colour_master', 'colour', null],
    array['sd_oos_sku_exclusion', 'sku', null],
    array['sd_tna_leadtimes', 'id', null],
    array['sd_cost_standards', 'id', null],
    array['sd_approval_matrix', 'id', null],
    array['sd_analytics_rule', 'rule_key', null],
    array['sd_custom_role', 'id', null],
    array['sd_user_role', 'user_email', 'role_id'],
    array['sd_nav_visibility', 'path', null],
    array['sd_vendor_type_multiplier', 'vendor_type', null],
    array['sd_issue_route', 'category', null],
    array['vendor_master_data', 'vendor_code', null]
  ];
  args text;
begin
  foreach spec slice 1 in array specs loop
    if to_regclass('public.' || spec[1]) is null then
      raise notice 'audit: % not found, skipped', spec[1];
      continue;
    end if;
    args := quote_literal(spec[2]) || coalesce(', ' || quote_literal(spec[3]), '');
    execute format('drop trigger if exists sd_audit on public.%I', spec[1]);
    execute format(
      'create trigger sd_audit after insert or update or delete on public.%I
         for each row execute function public.sd_audit_trigger(%s)',
      spec[1], args);
  end loop;
end;
$$;
