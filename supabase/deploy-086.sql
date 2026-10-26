-- 086: approval provisioning (idempotent, transactional), owner invites, fee settings, permit tracking.
-- Reverse with supabase/down/086_down.sql.
--
-- One license key per BUSINESS (kind='business'), matching the existing model (migration 038 and the
-- admin edge function's createBusiness). The owner's employees_cloud row (bcrypt temp password,
-- must_change_password) is created by the server from the invite, using the same bcryptjs the
-- staff-login function verifies with; this migration only records the invite.

alter table public.licenses  add column if not exists plan_type text check (plan_type in ('model_a','model_b'));
alter table public.locations add column if not exists city  text;
alter table public.locations add column if not exists state text;

-- ---------------------------------------------------------------- tables
create table if not exists public.provision_runs (
  application_id uuid primary key references public.onboarding_applications(id),
  tenant_id      uuid not null,
  license_id     uuid,
  result         jsonb not null,
  created_by     uuid,
  created_at     timestamptz not null default now()
);

create table if not exists public.owner_invites (
  id             uuid primary key default gen_random_uuid(),
  tenant_id      uuid not null,
  application_id uuid not null unique references public.onboarding_applications(id),
  email          text not null,
  full_name      text not null,
  token_hash     text not null unique,
  expires_at     timestamptz not null,
  consumed_at    timestamptz,
  created_at     timestamptz not null default now()
);

create table if not exists public.business_fee_settings (
  tenant_id        uuid primary key,
  online_fee_type  text not null check (online_fee_type in ('percent','flat')),
  online_fee_value numeric(10,2) not null check (online_fee_value >= 0),
  plan_snapshot    jsonb,
  created_at       timestamptz not null default now()
);

create table if not exists public.business_permits (
  id                    uuid primary key default gen_random_uuid(),
  tenant_id             uuid not null,
  location_id           uuid not null references public.locations(id) on delete cascade,
  kind                  text not null check (kind in ('tx_ecig','tobacco','sales_tax','tabc')),
  number                text,
  expiry                date,
  document_path         text,
  source_application_id uuid references public.onboarding_applications(id),
  created_at            timestamptz not null default now(),
  unique (location_id, kind)
);
create index if not exists idx_business_permits_expiry on public.business_permits (expiry);

create table if not exists public.permit_notices (
  permit_id   uuid not null references public.business_permits(id) on delete cascade,
  days_before integer not null check (days_before in (30, 7)),
  expiry      date not null,
  sent_at     timestamptz not null default now(),
  primary key (permit_id, days_before, expiry)
);

-- ---------------------------------------------------------------- RLS
alter table public.provision_runs        enable row level security;
alter table public.owner_invites         enable row level security;
alter table public.business_fee_settings enable row level security;
alter table public.business_permits      enable row level security;
alter table public.permit_notices        enable row level security;
revoke all on public.provision_runs, public.owner_invites, public.business_fee_settings,
  public.business_permits, public.permit_notices from anon, authenticated;
grant select on public.provision_runs, public.business_fee_settings, public.business_permits,
  public.permit_notices to authenticated;
-- owner_invites holds token hashes: no client access at all, admins included.

drop policy if exists provision_runs_admin on public.provision_runs;
create policy provision_runs_admin on public.provision_runs
  for select to authenticated using (public.is_platform_admin());
drop policy if exists permit_notices_admin on public.permit_notices;
create policy permit_notices_admin on public.permit_notices
  for select to authenticated using (public.is_platform_admin());

drop policy if exists fee_settings_select on public.business_fee_settings;
create policy fee_settings_select on public.business_fee_settings
  for select to authenticated using (public.is_platform_admin() or tenant_id = public.current_tenant_id());
drop policy if exists permits_select on public.business_permits;
create policy permits_select on public.business_permits
  for select to authenticated using (public.is_platform_admin() or tenant_id = public.current_tenant_id());

-- ---------------------------------------------------------------- provisioning
create or replace function public.onb_gen_license_key()
returns text
language plpgsql volatile
set search_path = public, extensions
as $$
declare
  alpha text := 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';  -- 32 chars, same alphabet as the admin function
  k text; seg integer; i integer;
begin
  loop
    k := 'RACKD';
    for seg in 1..3 loop
      k := k || '-';
      for i in 1..4 loop
        k := k || substr(alpha, 1 + (get_byte(extensions.gen_random_bytes(1), 0) % 32), 1);
      end loop;
    end loop;
    exit when not exists (select 1 from public.licenses where license_key = k);
  end loop;
  return k;
end;
$$;

-- Runs once per application. A second call (double click, retry, race) blocks on the application
-- row lock, then returns the stored result with already_provisioned=true and NO invite token, so
-- the caller must send the welcome email only when already_provisioned is false.
create or replace function public.onb_provision(p_app uuid, p_actor uuid default null)
returns jsonb
language plpgsql security definer
set search_path = public, extensions
as $$
declare
  a        public.onboarding_applications;
  v_prev   jsonb;
  v_tenant uuid := gen_random_uuid();
  v_key    text;
  v_license uuid;
  v_plans  jsonb; v_fee jsonb; v_addons jsonb;
  v_feats  text[];
  v_addon  text;
  v_regs   integer;
  v_loc    record;
  v_new_loc uuid;
  v_invite text := encode(extensions.gen_random_bytes(32), 'hex');
  v_locs   jsonb := '[]'::jsonb;
  v_result jsonb;
begin
  select * into a from public.onboarding_applications where id = p_app for update;
  if a.id is null then raise exception 'not_found'; end if;

  select result into v_prev from public.provision_runs where application_id = p_app;
  if v_prev is not null then
    return (v_prev - 'invite_token') || jsonb_build_object('already_provisioned', true);
  end if;

  if a.status not in ('submitted', 'in_review') then
    raise exception 'invalid_status: %', a.status;
  end if;
  if a.legal_name is null or a.plan_model is null then raise exception 'application_incomplete'; end if;
  if exists (select 1 from public.licenses where kind = 'business' and lower(name) = lower(a.legal_name)) then
    raise exception 'business_name_exists';
  end if;

  select value into v_plans  from public.app_config where key = 'plans';
  select value into v_fee    from public.app_config where key = 'online_fee';
  select value into v_addons from public.app_config where key = 'addons';

  v_feats := case a.plan_model
    when 'model_a' then array['cloud_access', 'inventory_management', 'web_store', 'rebate_reporting']
    else array['cloud_access', 'web_store'] end;
  foreach v_addon in array a.addons loop
    if v_addons ? v_addon and (v_addons -> v_addon ->> 'feature') is not null then
      v_feats := v_feats || (v_addons -> v_addon ->> 'feature');
    end if;
  end loop;
  select coalesce(array_agg(distinct f), '{}') into v_feats from unnest(v_feats) f;

  v_regs := case a.plan_model
    when 'model_a' then greatest(1, coalesce(nullif(a.operations ->> 'registers', '')::integer, 1))
    else 0 end;
  v_key := public.onb_gen_license_key();

  insert into public.licenses
    (license_key, tenant_id, active, tier, features, max_registers, location_count, name, kind, plan_type)
  values
    (v_key, v_tenant, true, case a.plan_model when 'model_a' then 'standard' else 'core' end, v_feats, v_regs,
     greatest(1, (select count(*) from public.onboarding_locations where application_id = p_app)::integer),
     a.legal_name, 'business', a.plan_model)
  returning id into v_license;

  for v_loc in select * from public.onboarding_locations where application_id = p_app order by sort_order, created_at loop
    -- storefront stays disabled until the owner publishes it
    insert into public.locations (tenant_id, name, address, city, state, zip, phone, is_storefront_enabled)
    values (v_tenant, v_loc.name, v_loc.street, v_loc.city, v_loc.state, v_loc.zip, v_loc.phone, false)
    returning id into v_new_loc;
    insert into public.business_permits (tenant_id, location_id, kind, number, expiry, document_path, source_application_id)
    select v_tenant, v_new_loc, l.kind, l.number, l.expiry, d.storage_path, p_app
      from public.onboarding_licenses l
      left join public.onboarding_documents d on d.id = l.document_id
     where l.location_id = v_loc.id;
    v_locs := v_locs || jsonb_build_object('id', v_new_loc, 'name', v_loc.name);
  end loop;

  insert into public.business_fee_settings (tenant_id, online_fee_type, online_fee_value, plan_snapshot)
  values (v_tenant, coalesce(v_fee ->> 'type', 'percent'), coalesce((v_fee ->> 'value')::numeric, 0),
          jsonb_build_object('plan', v_plans -> a.plan_model, 'addons', to_jsonb(a.addons)));

  insert into public.owner_invites (tenant_id, application_id, email, full_name, token_hash, expires_at)
  values (v_tenant, p_app, a.email, a.full_name, public.onb_hash(v_invite), now() + interval '14 days');

  update public.onboarding_applications
     set status = 'approved', provisioned_tenant_id = v_tenant, reviewed_by = p_actor, reviewed_at = now()
   where id = p_app;

  v_result := jsonb_build_object(
    'tenant_id', v_tenant, 'license_id', v_license, 'license_key', v_key, 'plan_type', a.plan_model,
    'features', to_jsonb(v_feats), 'locations', v_locs, 'owner_email', a.email, 'owner_name', a.full_name,
    'already_provisioned', false, 'invite_token', v_invite);

  -- stored result never contains the raw invite token
  insert into public.provision_runs (application_id, tenant_id, license_id, result, created_by)
  values (p_app, v_tenant, v_license, v_result - 'invite_token', p_actor);

  perform public.onb_event(p_app, 'approved', coalesce('admin:' || p_actor::text, 'system'), true,
    jsonb_build_object('message', 'Your application was approved.'));
  perform public.write_audit('application.approve', 'onboarding_applications', p_app::text,
    jsonb_build_object('status', a.status),
    jsonb_build_object('status', 'approved', 'tenant_id', v_tenant, 'license_id', v_license), p_actor);
  return v_result;
end;
$$;

-- First owner login flips approved -> activated. Called by the staff-login path (milestone 9).
create or replace function public.onb_mark_activated(p_tenant uuid)
returns boolean
language plpgsql security definer
set search_path = public
as $$
declare v_app uuid;
begin
  update public.onboarding_applications set status = 'activated'
   where provisioned_tenant_id = p_tenant and status = 'approved'
   returning id into v_app;
  if v_app is null then return false; end if;
  perform public.onb_event(v_app, 'activated', 'system', true, jsonb_build_object('message', 'Your account is active.'));
  return true;
end;
$$;

-- Owner invite redemption: validates and consumes the token once. Returns the invite row facts.
create or replace function public.onb_redeem_invite(p_token text)
returns jsonb
language plpgsql security definer
set search_path = public
as $$
declare r public.owner_invites;
begin
  update public.owner_invites set consumed_at = now()
   where token_hash = public.onb_hash(p_token) and consumed_at is null and expires_at > now()
   returning * into r;
  if r.id is null then raise exception 'invalid_token' using errcode = '28000'; end if;
  return jsonb_build_object('tenant_id', r.tenant_id, 'email', r.email, 'full_name', r.full_name);
end;
$$;

-- ---------------------------------------------------------------- permit expiry reminders
-- Bucket 30: expiry within 8..30 days. Bucket 7: expiry within 0..7 days. Each sent once per expiry date.
create or replace function public.permits_due_for_notice()
returns table (permit_id uuid, tenant_id uuid, location_name text, kind text, number text,
               expiry date, days_before integer, owner_email text, owner_name text)
language sql stable security definer
set search_path = public
as $$
  select p.id, p.tenant_id, l.name, p.kind, p.number, p.expiry, b.bucket, i.email, i.full_name
    from public.business_permits p
    join public.locations l on l.id = p.location_id
    join public.owner_invites i on i.tenant_id = p.tenant_id
    cross join lateral (
      select case when p.expiry - current_date between 8 and 30 then 30
                  when p.expiry - current_date between 0 and 7  then 7 end as bucket) b
   where p.expiry is not null and b.bucket is not null
     and not exists (select 1 from public.permit_notices n
                      where n.permit_id = p.id and n.days_before = b.bucket and n.expiry = p.expiry);
$$;

create or replace function public.permit_notice_mark(p_permit uuid, p_days integer, p_expiry date)
returns void
language sql security definer
set search_path = public
as $$
  insert into public.permit_notices (permit_id, days_before, expiry) values (p_permit, p_days, p_expiry)
  on conflict do nothing;
$$;

-- ---------------------------------------------------------------- grants (server only)
revoke all on function
  public.onb_gen_license_key(), public.onb_provision(uuid, uuid), public.onb_mark_activated(uuid),
  public.onb_redeem_invite(text), public.permits_due_for_notice(), public.permit_notice_mark(uuid, integer, date)
  from public, anon, authenticated;
grant execute on function
  public.onb_gen_license_key(), public.onb_provision(uuid, uuid), public.onb_mark_activated(uuid),
  public.onb_redeem_invite(text), public.permits_due_for_notice(), public.permit_notice_mark(uuid, integer, date)
  to service_role;
