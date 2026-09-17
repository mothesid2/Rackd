


create table if not exists public.license_registrations (
  id           uuid primary key default gen_random_uuid(),
  license_key  text not null,
  tenant_id    uuid not null,
  machine_id   text not null,
  activated_at timestamptz not null default now(),
  last_seen_at timestamptz not null default now(),
  unique (license_key, machine_id)
);

create index if not exists idx_license_registrations_key    on public.license_registrations (license_key);
create index if not exists idx_license_registrations_tenant on public.license_registrations (tenant_id);

alter table public.license_registrations enable row level security;

