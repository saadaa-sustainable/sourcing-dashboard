-- Vendor Invoices: a private link per vendor (schema row "PENDING AND FILLED INV VIEW",
-- VIEW TO VENDOR). Vendors have no login, so each vendor code gets its own long, random,
-- revocable token. The page behind it (/vendor-invoice/view/<token>) shows only that
-- vendor's filled entries and its pending ones; it reads through the server with the
-- service-role key, so anon gets no grant here.

create table if not exists public.sd_vendor_view_link (
  id             bigint generated always as identity primary key,
  token          text not null unique,
  vendor_code    text not null,
  created_by     text not null,
  created_at     timestamptz not null default now(),
  revoked_at     timestamptz,
  revoked_by     text,
  last_seen_at   timestamptz  -- named last_seen_at so the audit trigger ignores view stamps
);

create index if not exists sd_vendor_view_link_vendor_idx on public.sd_vendor_view_link (vendor_code);

alter table public.sd_vendor_view_link enable row level security;

drop policy if exists sd_vendor_view_link_read on public.sd_vendor_view_link;
create policy sd_vendor_view_link_read on public.sd_vendor_view_link
  for select to authenticated using ((select public.sd_is_saadaa()));

revoke all on public.sd_vendor_view_link from anon;
revoke insert, update, delete, truncate on public.sd_vendor_view_link from authenticated;
grant select on public.sd_vendor_view_link to authenticated;

do $$
begin
  if to_regprocedure('public.sd_audit_trigger()') is not null then
    drop trigger if exists sd_audit on public.sd_vendor_view_link;
    create trigger sd_audit after insert or update or delete on public.sd_vendor_view_link
      for each row execute function public.sd_audit_trigger('id');
  end if;
end $$;
