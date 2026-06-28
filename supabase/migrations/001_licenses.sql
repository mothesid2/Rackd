-- 001_licenses.sql
-- Licensing table + shared helpers used by every later migration.
--
-- RLS multi-tenancy assumes the client authenticates with a JWT carrying
-- `tenant_id` and `license_key` claims (e.g. a per-install signed token). The
-- anon key alone has no tenant context. The service_role key bypasses RLS and
-- is used server-side to provision/manage licenses.

-- ── shared helpers (defined once, reused by all cloud tables) ───────────────

-- Auto-update updated_at on every row UPDATE.
create or replace function public.set_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

-- Tenant id from the authenticated JWT.
create or replace function public.current_tenant_id()
returns uuid
language sql
stable
as $$
  select nullif(auth.jwt() ->> 'tenant_id', '')::uuid;
$$;

-- License key from the authenticated JWT.
create or replace function public.current_license_key()
returns text
language sql
stable
as $$
  select auth.jwt() ->> 'license_key';
$$;

-- ── licenses ────────────────────────────────────────────────────────────────
create table if not exists public.licenses (
  id            uuid primary key default gen_random_uuid(),
  license_key   text unique not null,
  tenant_id     uuid not null,
  active        boolean not null default true,
  tier          text check (tier in ('core','standard','pro','enterprise')),
  features      text[] not null default '{}',
  expires_at    timestamptz,
  max_registers integer not null default 1,
  location_count integer not null default 1,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now()
);

create index if not exists idx_licenses_tenant  on public.licenses (tenant_id);
create index if not exists idx_licenses_created  on public.licenses (created_at);
-- license_key already has a unique btree index from the UNIQUE constraint.

alter table public.licenses enable row level security;

-- A client may read ONLY its own license row, matched by license_key. There are
-- intentionally NO insert/update/delete policies: clients can never write here;
-- only the service_role (which bypasses RLS) manages licenses.
create policy "licenses_select_own"
  on public.licenses for select
  to authenticated
  using (license_key = public.current_license_key());

create trigger trg_licenses_updated_at
  before update on public.licenses
  for each row execute function public.set_updated_at();
