-- 081: platform admins, audit log, public/private app config, rate limiting.
-- Additive. Reverse with supabase/down/081_down.sql.

create extension if not exists pgcrypto with schema extensions;

-- ---------------------------------------------------------------- platform_admins
create table if not exists public.platform_admins (
  user_id    uuid primary key references auth.users(id) on delete cascade,
  email      text,
  created_at timestamptz not null default now()
);
alter table public.platform_admins enable row level security;
revoke all on public.platform_admins from anon, authenticated;
grant select on public.platform_admins to authenticated;

drop policy if exists platform_admins_select_self on public.platform_admins;
create policy platform_admins_select_self on public.platform_admins
  for select to authenticated using (user_id = auth.uid());
-- Admins are added by hand (SQL editor): insert into platform_admins (user_id, email) values (...).

create or replace function public.is_platform_admin()
returns boolean
language sql stable security definer
set search_path = public
as $$
  select exists (select 1 from public.platform_admins where user_id = auth.uid());
$$;
revoke all on function public.is_platform_admin() from public;
-- anon needs execute because RLS policies on public catalog/config tables call it; it returns false for anon.
grant execute on function public.is_platform_admin() to anon, authenticated, service_role;

-- ---------------------------------------------------------------- audit_log
create table if not exists public.audit_log (
  id         bigint generated always as identity primary key,
  actor      uuid,
  action     text not null,
  entity     text not null,
  entity_id  text,
  before     jsonb,
  after      jsonb,
  created_at timestamptz not null default now()
);
create index if not exists idx_audit_log_created on public.audit_log (created_at desc);
create index if not exists idx_audit_log_entity  on public.audit_log (entity, entity_id);
alter table public.audit_log enable row level security;
revoke all on public.audit_log from anon, authenticated;
grant select on public.audit_log to authenticated;

drop policy if exists audit_log_select_admin on public.audit_log;
create policy audit_log_select_admin on public.audit_log
  for select to authenticated using (public.is_platform_admin());
-- No insert/update/delete policies: rows are written only by write_audit(), never edited.

create or replace function public.write_audit(
  p_action text, p_entity text, p_entity_id text,
  p_before jsonb, p_after jsonb, p_actor uuid default null)
returns void
language plpgsql security definer
set search_path = public
as $$
begin
  insert into public.audit_log (actor, action, entity, entity_id, before, after)
  values (coalesce(p_actor, auth.uid()), p_action, p_entity, p_entity_id, p_before, p_after);
end;
$$;
revoke all on function public.write_audit(text, text, text, jsonb, jsonb, uuid) from public, anon, authenticated;
grant execute on function public.write_audit(text, text, text, jsonb, jsonb, uuid) to service_role;

-- Generic row-change audit trigger, attached to config-like tables.
create or replace function public.audit_row_change()
returns trigger
language plpgsql security definer
set search_path = public
as $$
declare
  r jsonb := to_jsonb(coalesce(new, old));
begin
  perform public.write_audit(
    tg_table_name || '.' || lower(tg_op), tg_table_name,
    coalesce(r ->> 'id', r ->> 'key'),
    case when tg_op <> 'INSERT' then to_jsonb(old) end,
    case when tg_op <> 'DELETE' then to_jsonb(new) end);
  return coalesce(new, old);
end;
$$;
revoke all on function public.audit_row_change() from public, anon, authenticated;

-- ---------------------------------------------------------------- app_config
create table if not exists public.app_config (
  key         text primary key,
  value       jsonb not null,
  is_public   boolean not null default false,  -- readable by anon (prices shown in the wizard/store)
  description text,
  updated_at  timestamptz not null default now(),
  updated_by  uuid
);
alter table public.app_config enable row level security;
revoke all on public.app_config from anon, authenticated;
grant select on public.app_config to anon, authenticated;
grant insert, update, delete on public.app_config to authenticated;

drop policy if exists app_config_select_public on public.app_config;
create policy app_config_select_public on public.app_config
  for select to anon, authenticated using (is_public or public.is_platform_admin());
drop policy if exists app_config_write_admin on public.app_config;
create policy app_config_write_admin on public.app_config
  for all to authenticated using (public.is_platform_admin()) with check (public.is_platform_admin());

create or replace function public.app_config_stamp()
returns trigger language plpgsql as $$
begin new.updated_at := now(); new.updated_by := auth.uid(); return new; end;
$$;
drop trigger if exists trg_app_config_stamp on public.app_config;
create trigger trg_app_config_stamp before insert or update on public.app_config
  for each row execute function public.app_config_stamp();
drop trigger if exists trg_app_config_audit on public.app_config;
create trigger trg_app_config_audit after insert or update or delete on public.app_config
  for each row execute function public.audit_row_change();

-- PLACEHOLDER values. Editable in the admin console; every edit is audit-logged.
insert into public.app_config (key, value, is_public, description) values
 ('plans', '{
    "is_placeholder": true,
    "model_a": {"name": "Full Rackd POS", "monthly_cents": 9900, "setup_cents": 0,
                "features": ["POS", "Online storefront", "Automatic inventory sync", "Rebate reporting"]},
    "model_b": {"name": "Online Storefront only", "monthly_cents": 4900, "setup_cents": 0,
                "features": ["Reserve-online storefront", "Curated item list", "iPad order board included"]}
  }', true, 'Plan prices and feature lists (placeholder)'),
 ('addons', '{
    "is_placeholder": true,
    "sms_marketing":     {"name": "SMS marketing",     "monthly_cents": 2900, "feature": "sms_marketing"},
    "loyalty_crm":       {"name": "Loyalty / CRM",     "monthly_cents": 1900, "feature": "loyalty"},
    "automated_rebates": {"name": "Automated rebates", "monthly_cents": 2900, "feature": "rebate_reporting"},
    "multi_location":    {"name": "Multi-location",    "monthly_cents": 3900, "feature": null},
    "extra_registers":   {"name": "Extra register",    "monthly_cents": 1500, "feature": null}
  }', true, 'Add-on prices (placeholder)'),
 ('online_fee', '{"is_placeholder": true, "type": "percent", "value": 5, "paid_by": "customer"}',
   true, 'Online order fee paid by the customer: type percent|flat (flat value in cents)'),
 ('hardware_tax', '{"is_placeholder": true, "mode": "flat", "rate_pct": 8.25}',
   true, 'Hardware sales tax: mode flat|stripe_tax'),
 ('hardware_shipping', '{"is_placeholder": true, "methods": [{"id": "ground", "name": "Ground (flat rate)", "cents": 1500}]}',
   true, 'Hardware shipping methods')
on conflict (key) do nothing;

-- ---------------------------------------------------------------- rate_limits
create table if not exists public.rate_limits (
  bucket       text not null,
  window_start timestamptz not null,
  hits         integer not null default 0,
  primary key (bucket, window_start)
);
alter table public.rate_limits enable row level security;
revoke all on public.rate_limits from anon, authenticated;
-- No policies: service_role only.

-- true = allowed, false = over the limit.
create or replace function public.rate_limit_hit(p_bucket text, p_window_seconds integer, p_max integer)
returns boolean
language plpgsql security definer
set search_path = public
as $$
declare
  w timestamptz := to_timestamp(floor(extract(epoch from now()) / p_window_seconds) * p_window_seconds);
  h integer;
begin
  insert into public.rate_limits as r (bucket, window_start, hits) values (p_bucket, w, 1)
  on conflict (bucket, window_start) do update set hits = r.hits + 1
  returning r.hits into h;
  if random() < 0.01 then
    delete from public.rate_limits where window_start < now() - interval '1 day';
  end if;
  return h <= p_max;
end;
$$;
revoke all on function public.rate_limit_hit(text, integer, integer) from public, anon, authenticated;
grant execute on function public.rate_limit_hit(text, integer, integer) to service_role;
