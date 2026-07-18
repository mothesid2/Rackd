-- 015_locations.sql
-- Multi-location foundation (spec v3): Tenant -> Location -> Register.
--
-- Before this, the model was flat: one license_key = one tenant_id = one store
-- (see 013_store_aggregates.sql). We introduce an explicit Location layer so a
-- tenant (business) can own multiple stores, each with its own auth code
-- (license_key) and its own set of registers (seats). Registers sharing a
-- location sync live data; they cannot see other locations.
--
-- This migration is non-breaking: it adds the location layer and backfills one
-- location per existing license, so single-store installs keep working. The
-- register/manager RLS split lands in 016.

-- ── auth helper: location id from the JWT ────────────────────────────────────
-- Mirrors public.current_tenant_id(). A register token carries location_id; a
-- manager (portal) token omits it, so this returns null and tenant-wide policies
-- apply. Added by the jwt-issuer Edge Function.
create or replace function public.current_location_id()
returns uuid
language sql
stable
as $$
  select nullif(auth.jwt() ->> 'location_id', '')::uuid;
$$;

-- ── locations ────────────────────────────────────────────────────────────────
create table if not exists public.locations (
  id         uuid primary key default gen_random_uuid(),
  tenant_id  uuid not null,
  name       text not null default 'Store',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists idx_locations_tenant on public.locations (tenant_id);

alter table public.locations enable row level security;

-- Readable by any authenticated token whose tenant matches (registers and the
-- manager portal both need to resolve their location name). Writes are
-- service_role only (owner console), so no insert/update/delete policies.
drop policy if exists "locations_select_own" on public.locations;
create policy "locations_select_own"
  on public.locations for select
  to authenticated
  using (tenant_id = public.current_tenant_id());

drop trigger if exists trg_locations_updated_at on public.locations;
create trigger trg_locations_updated_at
  before update on public.locations
  for each row execute function public.set_updated_at();

-- ── licenses gain a location ────────────────────────────────────────────────
-- One license_key (auth code) belongs to exactly one location.
alter table public.licenses add column if not exists location_id uuid;

create index if not exists idx_licenses_location on public.licenses (location_id);

-- Backfill: every existing license becomes its own single location (named from
-- the license's tenant name when present). Idempotent — only fills nulls.
do $$
declare
  lic record;
  new_loc uuid;
begin
  for lic in select id, tenant_id, name from public.licenses where location_id is null loop
    insert into public.locations (tenant_id, name)
    values (lic.tenant_id, coalesce(lic.name, 'Store'))
    returning id into new_loc;

    update public.licenses set location_id = new_loc where id = lic.id;
  end loop;
end $$;
